"""Deferred route registration for the routers split out of ``factorix.transport.app`` (R2-E B2).

``@router.get(...)`` / ``post`` / ``patch`` / ``delete`` / ``put`` / ``websocket`` record the call and return the
function unchanged; :meth:`RouteTable.register` replays the calls onto the FastAPI app with exactly the arguments
the original ``@app.get(...)`` decorators had. Unlike ``app.include_router(APIRouter)`` (which nests an included
router in ``app.routes`` on FastAPI >= 0.16x), the routes end up directly on ``app.router`` as before the split,
so route objects, ``app.routes`` introspection, dependency overrides and matching order are unchanged.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

_Endpoint = Callable[..., Any]


class RouteTable:
    """An ordered list of route registrations to apply to an app later."""

    def __init__(self) -> None:
        self._calls: list[tuple[str, str, dict[str, Any], _Endpoint]] = []

    def _record(self, method: str, path: str, kwargs: dict[str, Any]) -> Callable[[_Endpoint], _Endpoint]:
        def decorator(endpoint: _Endpoint) -> _Endpoint:
            self._calls.append((method, path, kwargs, endpoint))
            return endpoint

        return decorator

    def get(self, path: str, **kwargs: Any) -> Callable[[_Endpoint], _Endpoint]:
        return self._record("get", path, kwargs)

    def post(self, path: str, **kwargs: Any) -> Callable[[_Endpoint], _Endpoint]:
        return self._record("post", path, kwargs)

    def put(self, path: str, **kwargs: Any) -> Callable[[_Endpoint], _Endpoint]:
        return self._record("put", path, kwargs)

    def patch(self, path: str, **kwargs: Any) -> Callable[[_Endpoint], _Endpoint]:
        return self._record("patch", path, kwargs)

    def delete(self, path: str, **kwargs: Any) -> Callable[[_Endpoint], _Endpoint]:
        return self._record("delete", path, kwargs)

    def websocket(self, path: str, **kwargs: Any) -> Callable[[_Endpoint], _Endpoint]:
        return self._record("websocket", path, kwargs)

    @property
    def calls(self) -> tuple[tuple[str, str, dict[str, Any], _Endpoint], ...]:
        return tuple(self._calls)

    def register(self, app: Any) -> None:
        """Apply the recorded registrations, in recording order, as ``app.<method>(path, **kwargs)(endpoint)``."""
        for method, path, kwargs, endpoint in self._calls:
            getattr(app, method)(path, **kwargs)(endpoint)
