"""OPC UA read-only client. Write services are not exposed.

One persistent session per connection. The asyncua watchdog probes the server every
``watchdog_s``; on loss the session is marked down and the next read reconnects (the
job loop applies backoff). Subscriptions are owned by the job that created them and are
re-created after a reconnect (``generation`` changes).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Callable

from asyncua import Client, ua
from asyncua.client.ua_client import UaClientState

from factorix.domain.network import AllowedEndpoint, assert_url
from factorix_edge.aio import bounded
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.timeutil import iso_ms, now_iso

logger = logging.getLogger(__name__)

_AUTH_STATUS = {
    "BadUserAccessDenied",
    "BadIdentityTokenInvalid",
    "BadIdentityTokenRejected",
    "BadUserSignatureInvalid",
}
_SECURITY_STATUS = {
    "BadSecurityPolicyRejected",
    "BadSecurityChecksFailed",
    "BadCertificateInvalid",
    "BadCertificateUntrusted",
    "BadSecurityModeRejected",
}


def check_security(security_mode: Any, security_policy: Any) -> None:
    """Allow only the profiles this edge implements. No silent downgrade.

    Security ``None`` (mode None or policy None) is supported. Signed or encrypted
    profiles need a client application certificate, which this edge does not manage, so
    they are rejected with a clear error instead of connecting without security.
    """
    mode = str(security_mode or "").strip()
    policy = str(security_policy or "").strip()
    policy_is_none = policy in {"", "None"} or policy.endswith("#None")
    if mode == "None" or (policy_is_none and mode in {"", "None"}):
        return
    if policy_is_none and mode:
        # Mode Sign/SignAndEncrypt cannot be satisfied with policy None.
        raise ConnectorError(
            "SECURITY",
            f"OPC UA security mode {mode} needs a security policy, but the policy is None. Set the mode to None or choose a policy.",
        )
    raise ConnectorError(
        "SECURITY",
        f"OPC UA security {mode or 'Sign'}/{policy} needs a client certificate, which this edge does not support. "
        "Use an endpoint with security None.",
    )


def _status_name(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    try:
        return ua.StatusCode(code).name if code is not None else type(exc).__name__
    except Exception:  # noqa: BLE001 - unknown status codes have no name
        return type(exc).__name__


def translate(exc: BaseException, endpoint: str) -> ConnectorError:
    if isinstance(exc, ConnectorError):
        return exc
    name = _status_name(exc)
    if name in _AUTH_STATUS:
        return ConnectorError("AUTH", f"OPC UA server rejected the user identity ({name}).")
    if name in _SECURITY_STATUS:
        return ConnectorError("SECURITY", f"OPC UA server rejected the security profile ({name}).")
    if isinstance(exc, asyncio.TimeoutError):
        return ConnectorError("TIMEOUT", f"OPC UA server {endpoint} did not answer in time.")
    if isinstance(exc, (OSError, ConnectionError)):
        return ConnectorError("NETWORK", f"Cannot reach OPC UA server {endpoint}.")
    if isinstance(exc, ua.UaStatusCodeError):
        return ConnectorError("PROTOCOL", f"OPC UA request failed ({name}).")
    return ConnectorError("PROTOCOL", f"OPC UA request failed ({type(exc).__name__}).")


class OpcUaConnector:
    can_write = False

    def __init__(
        self,
        endpoint: str,
        allowlist: list[AllowedEndpoint],
        timeout_s: float = 4.0,
        *,
        security_mode: Any = "None",
        security_policy: Any = "None",
        username: str | None = None,
        password: str | None = None,
        watchdog_s: float = 2.0,
    ) -> None:
        assert_url(endpoint, allowlist)
        check_security(security_mode, security_policy)
        self.endpoint = endpoint
        self.timeout_s = timeout_s
        self.username = username or None
        self.password = password
        self.watchdog_s = watchdog_s
        self.client: Client | None = None
        self.generation = 0
        self._lost = False
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self.client is not None and not self._lost and self.client.uaclient.state is UaClientState.CONNECTED

    async def connect(self) -> None:
        client = Client(url=self.endpoint, timeout=self.timeout_s, watchdog_intervall=self.watchdog_s)
        if self.username:
            client.set_user(self.username)
            if self.password:
                client.set_password(self.password)

        async def _lost(exc: Exception) -> None:
            logger.warning("OPC UA session to %s lost: %r", self.endpoint, exc)
            self._lost = True

        client.connection_lost_callback = _lost
        try:
            await bounded(client.connect(), timeout=self.timeout_s * 3)
        except asyncio.CancelledError:
            await _quiet_disconnect(client)
            raise
        except Exception as exc:  # noqa: BLE001 - asyncua raises many types; translated below
            await _quiet_disconnect(client)
            raise translate(exc, self.endpoint) from exc
        self.client = client
        self._lost = False
        self.generation += 1

    async def ensure_connected(self) -> Client:
        async with self._lock:
            if not self.connected:
                await self.close()
                await self.connect()
            assert self.client is not None
            return self.client

    async def read_values(self, node_ids: list[str]) -> list[dict[str, Any]]:
        """Read all nodes in one Read service call. Per-node status gives per-node quality."""
        rows: list[dict[str, Any]] = []
        valid: list[tuple[int, ua.NodeId]] = []
        for index, node_id in enumerate(node_ids):
            rows.append({"node_id": node_id, "value": None, "quality": "BAD", "source_time": None, "error_code": None, "error": None})
            try:
                valid.append((index, ua.NodeId.from_string(node_id)))
            except Exception:  # noqa: BLE001 - asyncua raises several types for malformed ids
                rows[index]["error_code"] = "ADDRESS"
                rows[index]["error"] = "NodeId is not valid."
        if not valid:
            return rows
        client = await self.ensure_connected()
        params = ua.ReadParameters()
        params.TimestampsToReturn = ua.TimestampsToReturn.Both
        for _, nodeid in valid:
            item = ua.ReadValueId()
            item.NodeId = nodeid
            item.AttributeId = ua.AttributeIds.Value
            params.NodesToRead.append(item)
        try:
            values = await client.uaclient.read(params)
        except Exception as exc:  # noqa: BLE001 - asyncua raises many types; translated below
            self._lost = True
            raise translate(exc, self.endpoint) from exc
        for (index, _), data in zip(valid, values):
            rows[index].update(data_value_row(data))
        return rows

    async def subscribe(
        self,
        node_ids: list[str],
        on_change: Callable[[str, dict[str, Any]], None],
        period_ms: int = 250,
    ) -> tuple[Any, list[str]]:
        """Create one subscription for ``node_ids``. ``on_change(node_id, row)`` runs in the loop.

        Returns ``(subscription, node_ids_the_server_refused)``.
        """
        client = await self.ensure_connected()
        handler = _ChangeHandler(on_change, self)
        try:
            subscription = await client.create_subscription(max(50, int(period_ms)), handler)
            nodes = [client.get_node(ua.NodeId.from_string(node_id)) for node_id in node_ids]
            results = await subscription.subscribe_data_change(nodes, queuesize=1)
        except Exception as exc:  # noqa: BLE001 - asyncua raises many types; translated below
            raise translate(exc, self.endpoint) from exc
        failed = [node_ids[i] for i, handle in enumerate(results) if isinstance(handle, ua.StatusCode)]
        if failed:
            logger.warning("OPC UA could not monitor %d node(s) on %s: %s", len(failed), self.endpoint, failed[:5])
        return subscription, failed

    async def unsubscribe(self, subscription: Any) -> None:
        if subscription is None or not self.connected:
            return
        try:
            await subscription.delete()
        except Exception as exc:  # noqa: BLE001 - deleting on a dying session is best effort
            logger.info("OPC UA subscription delete on %s failed: %r", self.endpoint, exc)

    async def browse_children(self, node_id: str) -> list[dict[str, Any]]:
        client = await self.ensure_connected()
        try:
            node = client.get_node(node_id)
            children = await node.get_children()
        except Exception as exc:  # noqa: BLE001 - translated below
            raise ConnectorError("ADDRESS", f"Cannot browse OPC UA node '{node_id}'.") from exc
        results: list[dict[str, Any]] = []
        for child in children[:100]:
            try:
                b_name = await child.read_browse_name()
                d_name = await child.read_display_name()
                n_class = await child.read_node_class()
                grandkids = await child.get_children()
            except Exception as exc:  # noqa: BLE001 - one unreadable child must not hide the others
                logger.info("OPC UA browse skipped %s: %r", child.nodeid.to_string(), exc)
                continue
            results.append(
                {
                    "node_id": child.nodeid.to_string(),
                    "browse_name": getattr(b_name, "Name", None) or str(b_name),
                    "display_name": getattr(d_name, "Text", None) or str(d_name),
                    "node_class": getattr(n_class, "name", None) or str(n_class),
                    "has_children": len(grandkids) > 0,
                }
            )
        return results

    async def close(self) -> None:
        client, self.client = self.client, None
        if client is not None:
            await _quiet_disconnect(client)


class _ChangeHandler:
    def __init__(self, on_change: Callable[[str, dict[str, Any]], None], owner: OpcUaConnector) -> None:
        self.on_change = on_change
        self.owner = owner

    def datachange_notification(self, node: Any, val: Any, data: Any) -> None:
        del val
        arrival = now_iso()
        data_value = getattr(getattr(data, "monitored_item", None), "Value", None)
        row = data_value_row(data_value) if data_value is not None else {"value": None, "quality": "BAD", "source_time": None}
        row["received_time"] = arrival
        try:
            self.on_change(node.nodeid.to_string(), row)
        except Exception:  # noqa: BLE001 - a consumer bug must not kill the asyncua dispatcher
            logger.exception("OPC UA change handler failed")

    def status_change_notification(self, status: Any) -> None:
        logger.warning("OPC UA subscription status on %s: %s", self.owner.endpoint, status)
        self.owner._lost = True


def data_value_row(data: Any) -> dict[str, Any]:
    status = getattr(data, "StatusCode", None)
    good = status is None or _is_good(status)
    uncertain = status is not None and _is_uncertain(status)
    variant = getattr(data, "Value", None)
    value = _plain(getattr(variant, "Value", None)) if variant is not None else None
    source = getattr(data, "SourceTimestamp", None)
    row: dict[str, Any] = {
        "value": value if (good or uncertain) else None,
        "quality": "GOOD" if good else ("UNCERTAIN" if uncertain else "BAD"),
        "source_time": iso_ms(source) if isinstance(source, datetime) else None,
        "error_code": None if (good or uncertain) else "OPC_STATUS",
        "error": None if (good or uncertain) else f"OPC UA status {getattr(status, 'name', status)}",
    }
    return row


def _is_good(status: Any) -> bool:
    try:
        return bool(status.is_good())
    except AttributeError:
        return "Good" in str(status)


def _is_uncertain(status: Any) -> bool:
    try:
        return bool(status.is_uncertain())
    except AttributeError:
        return "Uncertain" in str(status)


def _plain(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, datetime):
        return iso_ms(value)
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return str(value)


async def _quiet_disconnect(client: Client) -> None:
    try:
        await bounded(client.disconnect(), timeout=3)
    except Exception as exc:  # noqa: BLE001 - the session is being discarded anyway
        logger.info("OPC UA disconnect: %r", exc)
