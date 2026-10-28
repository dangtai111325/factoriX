"""Password-reset mail. The SMTP password stays in the environment."""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from typing import Protocol

from factorix.platform.errors import AppError
from factorix.platform.settings import Settings


class ResetMailer(Protocol):
    def send_code(self, recipient: str, code: str) -> None: ...


class SmtpMailer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def message(self, recipient: str, code: str) -> EmailMessage:
        mail = EmailMessage()
        mail["From"] = self.settings.smtp_from
        mail["To"] = recipient
        mail["Subject"] = "FactoriX password reset"
        mail.set_content(
            "Your FactoriX password reset code is "
            f"{code}.\n\nIt expires in 10 minutes and can be used once. "
            "If you did not ask for this, you can ignore this message.\n"
        )
        return mail

    def send_code(self, recipient: str, code: str) -> None:
        password = self.settings.smtp_password.replace(" ", "")
        if not password or not self.settings.smtp_from or not self.settings.smtp_user:
            raise AppError(503, "MAIL_UNAVAILABLE", "Không gửi được mã.")
        mail = self.message(recipient, code)
        try:
            with smtplib.SMTP(self.settings.smtp_host, self.settings.smtp_port, timeout=20) as smtp:
                smtp.starttls()
                smtp.login(self.settings.smtp_user, password)
                smtp.send_message(mail)
        except AppError:
            raise
        except Exception:
            raise AppError(503, "MAIL_UNAVAILABLE", "Không gửi được mã.") from None
