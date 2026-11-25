"""Tenant database naming (R2-E B1/B7): one implementation of the four copies.

* ``platform.tdengine.tenant_database_name`` (checks the prefix first, raises ``TDEngineError``),
* ``modules.storage_dsl.tenant_td_database`` (parses the tenant id first, raises ``ValueError``),
* ``modules.storage_objects.TENANT_DB_PREFIX`` (the reserved prefix),
* ``modules.storage_topology._TENANT_DB_RE`` (recognises a tenant database name).

Callers keep their exception types through ``invalid_prefix`` and their check order through ``uuid_first``.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any
from uuid import UUID

TENANT_DB_PREFIX = "fx_t_"
# A database created by FactoriX for one tenant (default prefix): ``fx_t_`` + 32 lowercase hex digits.
TENANT_DB_RE = re.compile(r"^fx_t_[0-9a-f]{32}$")
DB_PREFIX_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,15}$")


def _invalid_prefix(prefix: Any) -> Exception:
    return ValueError(f"Invalid TDengine db prefix {prefix!r}")


def _to_uuid(value: Any) -> UUID:
    return UUID(str(value))


def is_tenant_database(name: Any) -> bool:
    """``bool(TENANT_DB_RE.fullmatch(name))`` (the ``storage_topology`` check)."""
    return isinstance(name, str) and TENANT_DB_RE.fullmatch(name) is not None


def tenant_database_name(
    tenant_id: Any,
    prefix: str = TENANT_DB_PREFIX,
    *,
    invalid_prefix: Callable[[Any], BaseException] = _invalid_prefix,
    to_uuid: Callable[[Any], UUID] = _to_uuid,
    uuid_first: bool = False,
) -> str:
    """``<prefix><tenant uuid hex>``; raises ``invalid_prefix(prefix)`` for a prefix that is not ``[A-Za-z][A-Za-z0-9_]{0,15}``.

    ``to_uuid`` parses the tenant id (``UUID(str(x))`` by default; it raises ``ValueError``/``TypeError`` for bad
    input). ``uuid_first`` parses the tenant id before validating the prefix (the ``storage_dsl`` order).
    """
    if uuid_first:
        uid_hex = to_uuid(tenant_id).hex
        if not DB_PREFIX_RE.fullmatch(prefix):
            raise invalid_prefix(prefix)
        return f"{prefix}{uid_hex}"
    if not DB_PREFIX_RE.fullmatch(prefix):
        raise invalid_prefix(prefix)
    return f"{prefix}{to_uuid(tenant_id).hex}"
