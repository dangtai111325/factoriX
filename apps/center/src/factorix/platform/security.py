"""Password hashing, session tokens, CSRF and secret encryption."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(stored_hash: str, presented: str) -> bool:
    return hmac.compare_digest(stored_hash, hash_token(presented))


def new_fernet(data_key: str) -> Fernet:
    try:
        return Fernet(data_key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("FACTORIX_DATA_KEY phải là khóa Fernet urlsafe base64.") from exc


def encrypt_secret(data_key: str, plaintext: str) -> bytes:
    return new_fernet(data_key).encrypt(plaintext.encode("utf-8"))


def decrypt_secret(data_key: str, ciphertext: bytes) -> str:
    try:
        return new_fernet(data_key).decrypt(ciphertext).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Không giải mã được bí mật.") from exc
