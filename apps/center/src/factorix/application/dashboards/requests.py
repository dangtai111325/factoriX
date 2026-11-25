"""Request bodies of ``/api/v1/dashboards/*``. Unknown keys are rejected (the tenant never comes from a body).

The dashboard *document* is accepted as a plain object and validated by :mod:`.documents`, so its problems are
reported as issues (422 ``VALIDATION`` with ``details.issues``) rather than as generic body errors.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DashboardIn(_Body):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field("", max_length=2000)
    site_id: str | None = None
    template_id: str | None = Field(None, max_length=80)
    role_map: dict[str, Any] | None = None
    source_dashboard_id: str | None = None


class DashboardPatch(_Body):
    version: int
    name: str | None = Field(None, min_length=1, max_length=160)
    description: str | None = Field(None, max_length=2000)
    document: dict[str, Any] | None = None


class ValidateIn(_Body):
    document: dict[str, Any] | None = None


class PublishIn(_Body):
    version: int
    note: str = Field("", max_length=500)


class VersionIn(_Body):
    version: int


class RestoreIn(_Body):
    revision: int = Field(ge=1)
    version: int


class DuplicateIn(_Body):
    name: str = Field(min_length=1, max_length=160)


class ImportIn(_Body):
    name: str | None = Field(None, min_length=1, max_length=160)
    payload: dict[str, Any]


class TemplateIn(_Body):
    dashboard_id: str
    name: str = Field(min_length=1, max_length=160)
    description: str = Field("", max_length=2000)
    category: str = Field("custom", min_length=1, max_length=40)


class ResolveIn(_Body):
    variables: dict[str, str | None] = Field(default_factory=dict)
    sources: list[Any] = Field(default_factory=list)
