"""Runtime settings. Secrets come from the environment, never from source."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_PLACEHOLDERS = {"", "change-me", "changeme", "password", "postgres", "secret"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FACTORIX_", env_file=".env", extra="ignore")

    environment: Literal["development", "test", "production"] = "production"
    database_url: str
    data_key: str
    bootstrap_token: str = ""
    session_ttl_minutes: int = Field(default=480, ge=15, le=1440)
    web_origin: str = "http://localhost:8080"
    cookie_secure: bool | None = None
    log_level: str = "INFO"
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = "tai.dang@avenue-net.com"
    smtp_password: str = ""
    smtp_from: str = "tai.dang@avenue-net.com"
    appliance: bool = False
    data_dir: str = ""
    web_dist: str = ""

    # RabbitMQ transport (§4)
    rabbitmq_url: str = ""
    rabbitmq_mgmt_url: str = ""
    rabbitmq_exchange: str = "factorix.telemetry.ingress"
    rabbitmq_queue: str = "factorix.telemetry.ingest.q"
    rabbitmq_dlx: str = "factorix.telemetry.dlx"
    rabbitmq_dlq: str = "factorix.telemetry.dlq"
    rabbitmq_max_length_bytes: int = Field(default=512 * 1024 * 1024, ge=65536)
    rabbitmq_delivery_limit: int = Field(default=5, ge=1, le=100)
    rabbitmq_prefetch: int = Field(default=128, ge=1, le=4096)
    rabbitmq_publisher_max_inflight: int = Field(default=64, ge=1, le=2048)
    rabbitmq_confirm_timeout_s: float = Field(default=10.0, ge=0.5, le=120.0)

    # TDengine data plane & exports (§5)
    tdengine_dsn: str = ""
    tdengine_db: str = "factorix_ts"
    tdengine_db_prefix: str = "fx_t_"
    tdengine_default_keep_days: int = Field(default=30, ge=1, le=3650)
    tdengine_default_cache_mb: int = Field(default=16, ge=0, le=4096)
    tdengine_pool_size: int = Field(default=4, ge=1, le=64)
    tdengine_vgroups: int | None = Field(default=1, ge=1, le=64)
    tdengine_query_timeout_s: float = Field(default=15.0, ge=1.0, le=120.0)
    tdengine_ddl_timeout_s: float = Field(default=45.0, ge=5.0, le=300.0)
    operational_history_days: int = Field(default=7, ge=1, le=3650)
    storage_export_dir: str = ""

    # Ingestion & local acquisition (§3, §4, §7)
    ingestion_batch_size: int = Field(default=256, ge=1, le=4096)
    ingestion_flush_ms: int = Field(default=100, ge=10, le=5000)
    ingestion_consumer_concurrency: int = Field(default=128, ge=1, le=2048)
    ingestion_shadow_pg: bool = False
    collector_mode: str = "edge"
    ot_allowlist: str = ""
    acquisition_spool_path: str = ""
    acquisition_spool_max_bytes: int = Field(default=128 * 1024 * 1024, ge=1_048_576)
    enable_destructive_tests: str = ""

    @field_validator("database_url")
    @classmethod
    def _db(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("FACTORIX_DATABASE_URL phải dùng driver postgresql+asyncpg.")
        return value

    @field_validator("data_key")
    @classmethod
    def _key(cls, value: str) -> str:
        if value.strip().lower() in _PLACEHOLDERS or len(value) < 32:
            raise ValueError("FACTORIX_DATA_KEY không hợp lệ.")
        return value

    @field_validator("rabbitmq_url")
    @classmethod
    def _rmq(cls, value: str) -> str:
        text = value.strip()
        if not text:
            return ""
        if not text.startswith(("amqp://", "amqps://")):
            raise ValueError("FACTORIX_RABBITMQ_URL must start with amqp:// or amqps://.")
        return text

    @field_validator("tdengine_dsn")
    @classmethod
    def _td(cls, value: str) -> str:
        text = value.strip()
        if not text:
            return ""
        if not text.startswith(("ws://", "wss://", "http://", "https://", "taos://", "taos+ws://")):
            raise ValueError("FACTORIX_TDENGINE_DSN must use ws://, wss://, or taos+ws://.")
        return text

    @property
    def secure_cookies(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
