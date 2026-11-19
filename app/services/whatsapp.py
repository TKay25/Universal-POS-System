"""WhatsApp Cloud API delivery.

Only the phone-number ID and an access token are needed to send. Both are read
from the environment so Render can hold the secret without touching the repo::

    WHATSAPP_PHONE_NUMBER_ID=1234567890
    WHATSAPP_ACCESS_TOKEN=EAAG...
    WHATSAPP_BUSINESS_NUMBER=+263771234567   # display only

Set ``POS_WHATSAPP_DRY_RUN=true`` locally to log messages instead of sending.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request

LOG = logging.getLogger(__name__)

GRAPH_ROOT = "https://graph.facebook.com"
MAX_TEXT = 3800  # Cloud API accepts 4096; leave room for numbering prefixes.


class WhatsAppError(RuntimeError):
    """A delivery problem that is safe to show to an administrator."""


def _config(key: str, default: str = "") -> str:
    try:
        from flask import current_app

        if key in current_app.config:
            return str(current_app.config.get(key) or "")
    except RuntimeError:  # outside an application context (CLI/health checks)
        pass
    return str(os.environ.get(key) or default)


def _dry_run() -> bool:
    raw = _config("WHATSAPP_DRY_RUN", "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def normalise_number(raw, default_country: str = "ZW") -> str:
    """Return ``+<digits>`` or raise ``ValueError``.

    Accepts ``+263 77 123 4567``, ``00263771234567`` and local Zimbabwe numbers
    such as ``0771 234 567``. Anything else must carry a country code.
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Enter a WhatsApp number.")
    digits = re.sub(r"\D", "", text)
    if not digits:
        raise ValueError("Enter a valid WhatsApp number.")
    if text.startswith("+"):
        normalized = digits
    elif text.startswith("00"):
        normalized = digits[2:]
    elif digits.startswith("0") and default_country.upper() == "ZW":
        normalized = "263" + digits[1:]
    else:
        normalized = digits
    if not 8 <= len(normalized) <= 15:
        raise ValueError("Include the country code, e.g. +263 77 123 4567.")
    return f"+{normalized}"


def mask_number(value: str) -> str:
    text = str(value or "")
    if len(text) <= 5:
        return text
    return f"{text[:4]}••••{text[-3:]}"


def config_status() -> dict:
    phone_number_id = _config("WHATSAPP_PHONE_NUMBER_ID").strip()
    token = _config("WHATSAPP_ACCESS_TOKEN").strip()
    return {
        "configured": bool(phone_number_id and token),
        "dry_run": _dry_run(),
        "phone_number_id": phone_number_id,
        "business_number": _config("WHATSAPP_BUSINESS_NUMBER").strip(),
        "api_version": _config("WHATSAPP_API_VERSION", "v23.0").strip() or "v23.0",
        "template": _config("WHATSAPP_TEMPLATE_NAME").strip(),
    }


def split_message(text: str, limit: int = MAX_TEXT) -> list[str]:
    """Split on paragraph boundaries and number the parts when needed."""
    body = str(text or "").strip()
    if len(body) <= limit:
        return [body] if body else []
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for paragraph in body.split("\n\n"):
        addition = len(paragraph) + (2 if current else 0)
        if current and length + addition > limit:
            chunks.append("\n\n".join(current))
            current = [paragraph]
            length = len(paragraph)
        else:
            current.append(paragraph)
            length += addition
    if current:
        chunks.append("\n\n".join(current))
    if len(chunks) == 1:
        return chunks
    total = len(chunks)
    return [f"({index}/{total})\n{chunk}" for index, chunk in enumerate(chunks, start=1)]


def send_text(to: str, body: str, *, preview_url: bool = False) -> list[dict]:
    """Send a text message. Returns one provider response per chunk."""
    try:
        number = normalise_number(to)
    except ValueError as error:
        raise WhatsAppError(str(error)) from error
    status = config_status()
    template = status["template"]
    chunks = split_message(body, 1000 if template else MAX_TEXT)
    if not chunks:
        raise WhatsAppError("The report message is empty.")
    if status["dry_run"]:
        LOG.info("WhatsApp dry-run to %s (%s chars)", mask_number(number), len(body))
        return [{"id": f"dry-run-{index}", "dry_run": True} for index, _ in enumerate(chunks, start=1)]
    if not status["configured"]:
        raise WhatsAppError(
            "WhatsApp is not connected. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN."
        )

    url = f"{GRAPH_ROOT}/{status['api_version']}/{status['phone_number_id']}/messages"
    token = _config("WHATSAPP_ACCESS_TOKEN").strip()
    results: list[dict] = []
    for chunk in chunks:
        if template:
            payload = {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": number.lstrip("+"),
                "type": "template",
                "template": {
                    "name": template,
                    "language": {"code": _config("WHATSAPP_TEMPLATE_LANGUAGE", "en")},
                    "components": [
                        {
                            "type": "body",
                            "parameters": [{"type": "text", "text": chunk}],
                        }
                    ],
                },
            }
        else:
            payload = {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": number.lstrip("+"),
                "type": "text",
                "text": {"preview_url": bool(preview_url), "body": chunk},
            }
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read() or b"{}"
                data = json.loads(raw.decode("utf-8", "replace") or "{}")
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                error_body = json.loads(error.read().decode("utf-8", "replace") or "{}")
                detail = (
                    ((error_body.get("error") or {}).get("message"))
                    or error_body.get("error_description")
                    or ""
                )
            except Exception:
                detail = ""
            raise WhatsAppError(
                f"WhatsApp rejected the message ({error.code})"
                + (f": {str(detail)[:180]}" if detail else ".")
            ) from error
        except urllib.error.URLError as error:
            raise WhatsAppError(f"Could not reach WhatsApp: {error.reason}") from error
        except TimeoutError as error:
            raise WhatsAppError("WhatsApp timed out. Try again shortly.") from error
        messages = data.get("messages") or []
        results.append(
            {
                "id": (messages[0] or {}).get("id") if messages else "",
                "status": "sent",
            }
        )
    return results


def send_test_message(to: str, company_name: str) -> list[dict]:
    body = (
        f"*{company_name}*\n"
        "WhatsApp reports are connected. Your daily executive summary will arrive at 6pm local time."
    )
    return send_text(to, body)
