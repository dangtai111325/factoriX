"""Connections, signals, formulas, releases and edge enrollment (data models: factorix.modules.data_models).

Compatibility shim (R2-E Phase B, B6): the implementation moved, unchanged, to
``factorix.application.collector.{schemas,connections,commissioning,signals,signal_bulk,formulas}`` and
``factorix.application.legacy_edge.fleet``. Every name is re-exported here, and attribute patches on this
module are forwarded to the new modules (``factorix._shims``).
"""

from __future__ import annotations

# Original imports, kept so every name importable from this module before the split still is.
import hashlib  # noqa: F401
import json  # noqa: F401
from datetime import timedelta  # noqa: F401
from typing import Any  # noqa: F401
from uuid import UUID, uuid4  # noqa: F401
from pydantic import BaseModel, Field, field_validator  # noqa: F401
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: F401
from factorix.domain.formula import FormulaError, bind, detect_cycles, evaluate, output_quality, parse_expression  # noqa: F401
from factorix.domain.jsonpath import MappingError, apply_cardinality, compile_path, evaluate as eval_path, suggest_type  # noqa: F401
from factorix.domain.units import add_units  # noqa: F401
from factorix.domain.source_address import AddressCheck, validate_address_patch  # noqa: F401
from factorix.domain.health import effective_connection_health, effective_edge_health  # noqa: F401
from factorix.modules.common import as_uuid, audit, execute, execute_rowcount, fetch_all, fetch_one, iso_ms, jsonb, parse_uuid, queue_stream_event, utcnow  # noqa: F401
from factorix.modules.protocols import (  # noqa: F401
    WEBSOCKET_DEFAULT_INTERVAL_MS,
    accept_connection,
    http_rate_warnings,
    mask_config,
    parse_config,
    public_protocol,
    redacted_endpoint,
    stored_protocol,
    unmask_config,
    validate_interval,
    validate_mqtt_topic,
)
from factorix.platform.errors import AppError  # noqa: F401
from factorix.platform.security import encrypt_secret, new_token, hash_token  # noqa: F401

from factorix.application.collector.schemas import (  # noqa: F401
    CAPABILITIES,
    CaptureIn,
    ConnectionIn,
    ConnectionPatch,
    FormulaIn,
    JobIn,
    MappingPreviewIn,
    PreviewIn,
    SUBSCRIBE_PROTOCOLS,
    SignalAddressItem,
    SignalBulkActionIn,
    SignalBulkAddressIn,
    SignalBulkIn,
    SignalBulkItem,
    SignalBulkPropertiesIn,
    SignalPatch,
    SignalPropertyItem,
    _SECRET_AUTH,
)
from factorix.application.legacy_edge.fleet import (  # noqa: F401
    EdgeIn,
    EdgePatch,
    ReleaseIn,
    _assert_edge_can_run,
    _assert_local_acquisition_can_run,
    _edges_of_signals,
    _notify_config_changed,
    _owned_edge,
    bump_edge_release,
    create_edge,
    delete_edge,
    issue_enrollment,
    patch_edge,
    publish_release,
)
from factorix.application.collector.connections import (  # noqa: F401
    _active_binding_counts,
    _connection_row,
    _connection_warnings,
    _decorate_connection,
    _job_defaults,
    _mask_config,
    _queue_connection_health,
    _require_secret,
    _resolve_site_id,
    _signal_type,
    archive_connection,
    create_connection,
    get_connection,
    list_connections,
    patch_connection,
    pause_connection,
    resume_connection,
)
from factorix.application.collector.commissioning import (  # noqa: F401
    TestIn,
    capture_connection,
    request_commission,
)
from factorix.application.collector.signals import (  # noqa: F401
    _SOURCE_SQL,
    _current_sources,
    _readdress,
    _rebind_signal,
    _set_binding_enabled,
    _signal,
    _source_view,
    check_address_change,
    delete_signal,
    list_signals,
    patch_signal,
)
from factorix.application.collector.signal_bulk import (  # noqa: F401
    BULK_PROPERTY_KEYS,
    NUMERIC_SIGNAL_TYPES,
    bulk_action_signals,
    bulk_address_signals,
    bulk_properties_signals,
    bulk_signals,
)
from factorix.application.collector.formulas import (  # noqa: F401
    _formula_graph,
    preview_formula,
    publish_formula,
    save_formula,
    validate_mapping,
)

from factorix import _shims  # noqa: E402

_shims.forward_patches(
    __name__,
    "factorix.application.collector.schemas",
    "factorix.application.legacy_edge.fleet",
    "factorix.application.collector.connections",
    "factorix.application.collector.commissioning",
    "factorix.application.collector.signals",
    "factorix.application.collector.signal_bulk",
    "factorix.application.collector.formulas",
)
