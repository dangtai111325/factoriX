"""R2 soft purge of the telemetry queues (non-fatal when the broker is offline: the epoch fence protects)
(R2-E B8, moved verbatim from ``factorix.modules.telemetry_reset``)."""

from __future__ import annotations

from collections.abc import Mapping
import logging
from typing import Any


logger = logging.getLogger("factorix.modules.telemetry_reset")


def _extract_purged_count(res: Any) -> int:
    if isinstance(res, Mapping):
        return int(res.get("messages_purged") or res.get("purged") or res.get("message_count") or 0)
    if isinstance(res, (int, float)) and not isinstance(res, bool):
        return int(res)
    msg_cnt = getattr(res, "message_count", None)
    if isinstance(msg_cnt, int) and not isinstance(msg_cnt, bool):
        return msg_cnt
    return 0


async def _purge_broker_softly(broker: Any) -> dict[str, Any]:
    """Purge queued telemetry messages if broker is reachable; non-fatal if offline."""
    if broker is None:
        return {"attempted": False, "purged": False, "messages_purged": 0, "status": "SKIPPED_NO_BROKER"}
    try:
        inst_dict = getattr(broker, "__dict__", {}) or {}
        cls_dict = getattr(type(broker), "__dict__", {}) or {}
        method_names = ("purge_queue", "purge_telemetry_queues", "purge")
        chosen_fn: Any = None
        for name in method_names:
            if name in inst_dict or name in cls_dict:
                cand = getattr(broker, name, None)
                if callable(cand):
                    chosen_fn = cand
                    break
        if chosen_fn is None:
            for name in method_names:
                cand = getattr(broker, name, None)
                if callable(cand) and not hasattr(broker, "amqp_url"):
                    chosen_fn = cand
                    break
        if chosen_fn is not None:
            res = await chosen_fn()
            return {
                "attempted": True,
                "purged": True,
                "messages_purged": _extract_purged_count(res),
                "status": "PURGED",
            }
        if isinstance(getattr(broker, "amqp_url", None), str) and broker.amqp_url:
            import aio_pika

            conn = await aio_pika.connect(broker.amqp_url, timeout=3.0)
            purged_total = 0
            try:
                channel = await conn.channel()
                for q_attr in ("queue_name", "dlq_name"):
                    q_name = getattr(broker, q_attr, None)
                    if isinstance(q_name, str) and q_name:
                        try:
                            q_obj = await channel.declare_queue(q_name, passive=True)
                            del_res = await q_obj.purge()
                            purged_total += _extract_purged_count(del_res)
                        except Exception:  # noqa: BLE001
                            pass
            finally:
                await conn.close()
            return {"attempted": True, "purged": True, "messages_purged": purged_total, "status": "PURGED"}
        return {"attempted": True, "purged": True, "messages_purged": 0, "status": "NOOP"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Soft broker purge skipped during telemetry reset (epoch fence active): %s", exc)
        return {
            "attempted": True,
            "purged": False,
            "messages_purged": 0,
            "status": "SOFT_FAILED_EPOCH_FENCED",
            "warning": str(exc),
        }
