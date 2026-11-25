"""Dashboard Studio (read-side bounded context, ADR-019; contract ``docs/architecture/contracts/dashboard.md``).

Modules:

* :mod:`.registry` — widget types, option specs, theme presets, limits (the single source of truth);
* :mod:`.documents` — document schema v1 (strict models), legacy upgrade, structural/completeness checks;
* :mod:`.sources` — source catalog, capabilities and batched resolution (signals, model fields, signal keys);
* :mod:`.validation` — full validation (structure + resolution + fit) for validate/publish;
* :mod:`.templates` — built-in role-based templates and tenant templates;
* :mod:`.store` — PostgreSQL access (``dashboards``, ``dashboard_revisions``, ``dashboard_templates``);
* :mod:`.service` — the use cases called by ``transport/http/routers/dashboards.py``.

Dashboards store metadata only. Live values come from ``/stream`` and history from the Historian; there is
no dashboard query facade, no external source and no write path to devices.
"""

from __future__ import annotations

from factorix.application.dashboards.registry import WIDGET_TYPES
from factorix.application.dashboards.requests import DashboardIn, DashboardPatch
from factorix.application.dashboards.service import (
    create_dashboard,
    get_dashboard,
    list_dashboards,
    patch_dashboard,
    publish_dashboard,
)

#: Widget type keys of the registry (kept for importers of the pre-Studio module).
WIDGETS = frozenset(WIDGET_TYPES)

__all__ = [
    "WIDGETS",
    "DashboardIn",
    "DashboardPatch",
    "create_dashboard",
    "get_dashboard",
    "list_dashboards",
    "patch_dashboard",
    "publish_dashboard",
]
