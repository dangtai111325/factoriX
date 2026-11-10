"""Connector error taxonomy. Messages stay safe for operators."""

from __future__ import annotations


class ConnectorError(Exception):
    """A source-side failure translated from a library exception.

    ``code`` is a stable machine code (NETWORK, TIMEOUT, AUTH, RATE_LIMITED, SECURITY,
    ADDRESS, PROTOCOL, DECODE, CONFIG, MODBUS_EXCEPTION, ...). ``retry_after`` (seconds)
    is set when the source told us when to retry.
    """

    def __init__(self, code: str, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


# Connection state reported per error code. Everything else is DOWN.
STATE_BY_CODE = {
    "AUTH": "AUTH_FAILED",
    "RATE_LIMITED": "RATE_LIMITED",
}


CAPABILITIES = {
    "modbus_tcp": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "opcua": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": True, "can_write": False},
    "mqtt": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
    "http": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "websocket": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
}
