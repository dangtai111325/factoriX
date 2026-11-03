"""Own the bounded, transient Edge MQTT discovery lifecycle."""

from datetime import timedelta
import json
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.mqtt_topics import filter_covers, valid_filter
from factorix.modules.common import as_uuid, audit, execute, fetch_one, jsonb, utcnow
from factorix.platform.errors import AppError

MAX_RESULT_BYTES = 1_000_000
MAX_SAMPLE_BYTES = 65_536


class CaptureIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    topic_filter: str = Field(min_length=1, max_length=2048)
    duration_s: int = Field(default=5, ge=2, le=30, strict=True)

    @field_validator('topic_filter')
    @classmethod
    def validate_filter(cls, value: str) -> str:
        if not valid_filter(value):
            raise ValueError('Use a valid MQTT topic filter up to 2048 UTF-8 bytes.')
        return value


class CaptureSample(BaseModel):
    model_config = ConfigDict(extra='forbid')
    topic: str = Field(min_length=1, max_length=2048)
    payload: Any = None
    received_time: AwareDatetime
    source_time: AwareDatetime | None = None
    error: Literal['DECODE', 'SAMPLE_TOO_LARGE'] | None = None

    @model_validator(mode='after')
    def validate_sample(self):
        if not valid_filter(self.topic) or '+' in self.topic or '#' in self.topic:
            raise ValueError('A captured topic must be concrete.')
        if len(json.dumps(self.payload, ensure_ascii=False, allow_nan=False).encode()) > MAX_SAMPLE_BYTES:
            raise ValueError('A captured payload is limited to 64 KiB.')
        if self.error and self.payload is not None:
            raise ValueError('Omitted or undecodable samples must not claim a decoded payload.')
        return self


class CaptureResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['COMPLETED', 'FAILED']
    samples: list[CaptureSample] = Field(default_factory=list, max_length=2000)
    received: int = Field(default=0, ge=0, le=2**63-1)
    dropped: int = Field(default=0, ge=0, le=2**63-1)
    truncated: bool = False
    error_code: Literal['TIMEOUT', 'AUTH', 'SUBSCRIBE', 'NETWORK', 'TLS', 'PROTOCOL', 'CANCELLED', 'INTERNAL'] | None = None

    @model_validator(mode='after')
    def validate_result(self):
        if len({s.topic for s in self.samples}) != len(self.samples):
            raise ValueError('Capture results must contain only the latest sample for each topic.')
        if self.status == 'COMPLETED' and (not self.samples or self.error_code or self.received < len(self.samples)):
            raise ValueError('A completed capture must contain actual samples and consistent counters.')
        if self.status == 'FAILED' and (not self.error_code or self.samples):
            raise ValueError('A failed capture requires a reason and no partial result.')
        if len(json.dumps(self.model_dump(mode='json'), ensure_ascii=False, allow_nan=False).encode()) > MAX_RESULT_BYTES:
            raise ValueError('Capture results are limited to 1 MB.')
        return self


async def expire(session: AsyncSession, *, tenant_id: UUID | None = None, edge_id: UUID | None = None) -> None:
    if tenant_id is None and edge_id is None:
        raise ValueError('Capture expiry requires an owner.')
    scope = 'j.tenant_id=:owner' if tenant_id else 'j.edge_id=:owner'
    params = {'owner': tenant_id or edge_id}
    await execute(session, f"""
        UPDATE mqtt_topic_captures j SET status='FAILED', completed_at=now(), result_json=NULL,
            error_code=CASE WHEN j.connection_version<>c.version OR c.status='ARCHIVED' OR e.enrollment_status<>'ENROLLED'
                THEN 'CONFIG_CHANGED' ELSE 'TIMEOUT' END
        FROM connections c, edge_nodes e
        WHERE j.connection_id=c.id AND j.edge_id=e.id AND {scope} AND j.status IN ('PENDING','RUNNING')
            AND (j.expires_at<=now() OR j.connection_version<>c.version OR c.status='ARCHIVED' OR e.enrollment_status<>'ENROLLED')
    """, params)
    await execute(session, f"""
        DELETE FROM mqtt_topic_captures j WHERE {scope} AND j.status NOT IN ('PENDING','RUNNING')
          AND j.completed_at < now()-interval '24 hours'
    """, params)


def public(row: dict[str, Any]) -> dict[str, Any]:
    keys = ('id', 'connection_id', 'connection_version', 'edge_id', 'topic_filter', 'duration_s', 'status',
            'created_at', 'expires_at', 'started_at', 'completed_at', 'error_code')
    output = {key: row.get(key) for key in keys}
    if row['status'] == 'COMPLETED':
        output.update({k: v for k, v in (row.get('result_json') or {}).items() if k not in {'status', 'error_code'}})
    return output


async def request_capture(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID,
                          body: CaptureIn, correlation_id: str) -> dict[str, Any]:
    connection = await fetch_one(session, 'SELECT * FROM connections WHERE id=:id AND tenant_id=:tenant',
                                 {'id': connection_id, 'tenant': tenant_id})
    if connection is None:
        raise AppError(404, 'NOT_FOUND', 'Connection not found.')
    if connection['protocol'] != 'mqtt':
        raise AppError(422, 'PROTOCOL', 'Topic capture requires an MQTT connection.')
    edge = await fetch_one(session, 'SELECT enrollment_status FROM edge_nodes WHERE id=:id AND tenant_id=:tenant FOR UPDATE',
                          {'id': connection['edge_id'], 'tenant': tenant_id})
    if edge is None or edge['enrollment_status'] != 'ENROLLED':
        raise AppError(409, 'EDGE_NOT_ENROLLED', 'Enroll the connection\'s Edge before capturing topics.')
    if connection['status'] == 'ARCHIVED':
        raise AppError(409, 'ARCHIVED', 'Restore the connection before capturing topics.')
    if not any(filter_covers(f, body.topic_filter) for f in connection['config_json'].get('topics', [])):
        raise AppError(422, 'TOPIC_SCOPE', 'The capture filter must be within the connection\'s configured topic filters.')
    await expire(session, edge_id=as_uuid(connection['edge_id']))
    busy = await fetch_one(session, "SELECT id FROM mqtt_topic_captures WHERE edge_id=:id AND status IN ('PENDING','RUNNING')",
                           {'id': connection['edge_id']})
    if busy:
        raise AppError(409, 'CAPTURE_BUSY', 'A capture is already pending or running on this Edge. Wait or cancel it first.')
    job_id, now = uuid4(), utcnow()
    await execute(session, """
        INSERT INTO mqtt_topic_captures(id, tenant_id, connection_id, edge_id, connection_version, requested_by,
            topic_filter, duration_s, status, created_at, expires_at)
        VALUES (:id,:tenant,:connection,:edge,:version,:actor,:topic,:duration,'PENDING',:now,:expiry)
    """, {'id': job_id, 'tenant': tenant_id, 'connection': connection_id, 'edge': connection['edge_id'],
          'version': connection['version'], 'actor': actor, 'topic': body.topic_filter, 'duration': body.duration_s,
          'now': now, 'expiry': now + timedelta(seconds=60 + body.duration_s)})
    await audit(session, tenant_id=tenant_id, actor_id=actor, event_type='TOPIC_CAPTURE_REQUEST', entity_type='connection',
                entity_id=connection_id, before=None, after={'capture_id': str(job_id), 'topic_filter': body.topic_filter}, correlation_id=correlation_id)
    return await get_capture(session, job_id, tenant_id=tenant_id)


async def get_capture(session: AsyncSession, job_id: UUID, *, tenant_id: UUID | None = None,
                      edge_id: UUID | None = None, lock: bool = False) -> dict[str, Any]:
    await expire(session, tenant_id=tenant_id, edge_id=edge_id)
    scope = 'tenant_id=:owner' if tenant_id else 'edge_id=:owner'
    row = await fetch_one(session, f'SELECT * FROM mqtt_topic_captures WHERE id=:id AND {scope}' + (' FOR UPDATE' if lock else ''),
                         {'id': job_id, 'owner': tenant_id or edge_id})
    if row is None:
        raise AppError(404, 'NOT_FOUND', 'Topic capture not found or expired.')
    return row if lock else public(row)


async def cancel_capture(session: AsyncSession, tenant_id: UUID, job_id: UUID) -> dict[str, Any]:
    row = await get_capture(session, job_id, tenant_id=tenant_id, lock=True)
    if row['status'] in {'PENDING', 'RUNNING'}:
        await execute(session, "UPDATE mqtt_topic_captures SET status='CANCELLED', completed_at=now(), result_json=NULL WHERE id=:id", {'id': job_id})
    return await get_capture(session, job_id, tenant_id=tenant_id)


async def pull(session: AsyncSession, edge_id: UUID) -> dict[str, Any]:
    await expire(session, edge_id=edge_id)
    job = await fetch_one(session, """
        SELECT j.*, c.config_json, c.secret_ref FROM mqtt_topic_captures j JOIN connections c ON c.id=j.connection_id
        WHERE j.edge_id=:edge AND j.status='PENDING' ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    """, {'edge': edge_id})
    if job is None:
        return {'job': None}
    await execute(session, "UPDATE mqtt_topic_captures SET status='RUNNING', started_at=now() WHERE id=:id", {'id': job['id']})
    command = {k: job[k] for k in ('id','connection_id','connection_version','topic_filter','duration_s','expires_at','config_json','secret_ref')}
    return {'job': command}


async def finish(session: AsyncSession, edge_id: UUID, job_id: UUID, body: CaptureResult) -> dict[str, Any]:
    row = await get_capture(session, job_id, edge_id=edge_id, lock=True)
    result = body.model_dump(mode='json')
    if row['status'] in {'COMPLETED', 'FAILED'} and row.get('result_json') == result:
        return {'id': str(job_id), 'status': row['status']}
    if row['status'] != 'RUNNING':
        raise AppError(409, 'STATE', 'Only a running, unexpired topic capture can be completed.')
    if any(not filter_covers(row['topic_filter'], s.topic) for s in body.samples):
        raise AppError(422, 'TOPIC_SCOPE', 'A captured topic is outside the requested filter.')
    await execute(session, """
        UPDATE mqtt_topic_captures SET status=:status, result_json=CAST(:result AS jsonb), error_code=:error,
            completed_at=now() WHERE id=:id
    """, {'id': job_id, 'status': body.status, 'result': jsonb(result), 'error': body.error_code})
    return {'id': str(job_id), 'status': body.status}
