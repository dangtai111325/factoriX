"""Telemetry ingestion pipeline (RabbitMQ -> validation -> epoch fence -> TDengine -> latest state -> NOTIFY), split by stage.

The public import path ``factorix.modules.ingestion_worker`` remains a re-export shim.
"""
