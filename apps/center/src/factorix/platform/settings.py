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

    @property
    def secure_cookies(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
