"""Compatibility support for the R2-E Phase B module splits (move-only refactor).

A split module (for example ``factorix.modules.ingestion_worker``) is kept as a shim that re-exports every
name from the modules its code moved to. Callers that patch a name on the OLD module
(``monkeypatch.setattr(ingestion_worker, "fetch_all", fake)``, ``unittest.mock.patch("factorix.modules.
collect.bump_edge_release")``) expect the patch to reach the code that used to live there. Since that code
now resolves globals in its new module, :func:`forward_patches` makes attribute assignment on the shim also
rebind the same name in each new module that still holds the *same object* as the shim. Reads are not
affected and nothing happens at import time besides swapping the module class.

Remove the forwarding (and eventually the shim) once callers import and patch the new module paths.
"""

from __future__ import annotations

import importlib
import sys
import types
from collections.abc import Iterable

_MISSING = object()


class _ForwardingModule(types.ModuleType):
    """Module type whose ``setattr``/``delattr`` also apply to the split-out modules (same object only)."""

    def __setattr__(self, name: str, value: object) -> None:
        targets = self.__dict__.get("_fx_forward_targets", ())
        if targets and not name.startswith("__"):
            old = self.__dict__.get(name, _MISSING)
            if old is not _MISSING:
                for mod in targets:
                    if mod.__dict__.get(name, _MISSING) is old:
                        setattr(mod, name, value)
        super().__setattr__(name, value)

    def __delattr__(self, name: str) -> None:
        targets = self.__dict__.get("_fx_forward_targets", ())
        if targets and not name.startswith("__"):
            old = self.__dict__.get(name, _MISSING)
            if old is not _MISSING:
                for mod in targets:
                    if mod.__dict__.get(name, _MISSING) is old:
                        delattr(mod, name)
        super().__delattr__(name)


def forward_patches(shim_name: str, *module_names: str | Iterable[str]) -> None:
    """Make attribute patches on module ``shim_name`` reach ``module_names`` (see module docstring)."""
    names: list[str] = []
    for item in module_names:
        names.extend([item] if isinstance(item, str) else list(item))
    shim = sys.modules[shim_name]
    targets = tuple(importlib.import_module(n) for n in names)
    shim.__dict__["_fx_forward_targets"] = targets
    shim.__class__ = _ForwardingModule
