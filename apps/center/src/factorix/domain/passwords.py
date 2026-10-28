"""Password policy. No default credentials live here."""

from __future__ import annotations

import re

_CLASSES = (
    re.compile(r"[a-z]"),
    re.compile(r"[A-Z]"),
    re.compile(r"\d"),
    re.compile(r"[^A-Za-z0-9]"),
)
_EMAIL = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$")
_BLOCKED = {
    "admin",
    "adminadmin",
    "password",
    "password123",
    "factorix",
    "factorix123",
    "changeme",
    "qwerty12345",
}


class PasswordPolicyError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def validate_password(password: str, login: str) -> None:
    if len(password) < 12 or len(password) > 128:
        raise PasswordPolicyError("WEAK_PASSWORD", "Mật khẩu phải từ 12 đến 128 ký tự.")
    if password.lower() in _BLOCKED or login.lower() in password.lower():
        raise PasswordPolicyError("WEAK_PASSWORD", "Mật khẩu quá dễ đoán.")
    if sum(1 for pattern in _CLASSES if pattern.search(password)) < 3:
        raise PasswordPolicyError("WEAK_PASSWORD", "Mật khẩu cần ít nhất 3 nhóm ký tự.")
    if password != password.strip() or any(ch in password for ch in ("\n", "\r", "\x00")):
        raise PasswordPolicyError("WEAK_PASSWORD", "Mật khẩu chứa ký tự không hợp lệ.")


def validate_email(email: str) -> str:
    cleaned = email.strip().lower()
    if len(cleaned) > 254 or not _EMAIL.fullmatch(cleaned):
        raise PasswordPolicyError("INVALID_EMAIL", "Email không hợp lệ.")
    return cleaned


def validate_login(login: str) -> str:
    cleaned = login.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", cleaned):
        raise PasswordPolicyError("INVALID_LOGIN", "Tên đăng nhập không hợp lệ.")
    return cleaned
