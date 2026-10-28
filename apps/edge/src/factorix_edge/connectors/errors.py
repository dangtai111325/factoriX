"""Connector error taxonomy. Messages stay safe for operators."""

from __future__ import annotations


class ConnectorError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


CAPABILITIES = {
    "modbus_tcp": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "opcua": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": True, "can_write": False},
    "mqtt": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
    "http": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
}
