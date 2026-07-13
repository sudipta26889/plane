# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Dograh voice-agent call-note endpoints.

Two body-only endpoints (Dograh's HTTP tool cannot template URL paths):
  POST /workspaces/<slug>/call-notes/upsert/  — create-or-append call block
  POST /workspaces/<slug>/call-notes/lookup/  — returning-caller history

Design notes:
- One work-item per (project, phone). external_source="dograh_call",
  external_id=<last 10 phone digits> is the dedup key.
- description_html accumulates every call, oldest first, blocks separated by
  a marker line. call_count = number of markers in stored HTML.
- ponytail: assumes serialized calls per number (voice flow). No DB-level
  unique constraint on (external_source, external_id), so a truly concurrent
  double-upsert could create two rows — real-world impossible for a phone
  channel. Add a UniqueConstraint if this ever runs multi-client.
"""

# Python imports
import re

# Django imports
from django.utils import timezone as dj_tz
import zoneinfo

# Third-party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from taskpilot.db.models import Issue, Project
from taskpilot.utils.content_validator import validate_html_content
from .base import BaseAPIView


DOGRAH_SOURCE = "dograh_call"
CALL_MARKER = "\U0001f4de Call —"  # "📞 Call —" — counted for call_count
IST = zoneinfo.ZoneInfo("Asia/Kolkata")

CATEGORY_TO_PROJECT = {
    "home_automation": "3bf5de11-7c34-43ae-9652-cfe9c6b9b4fa",
    "export":          "c89e1849-b0a2-4a17-90e3-f231b0c9c60b",
    "event":           "1f9cbea4-28c8-48bf-ac44-af1fc9506bcd",
}
PROJECT_TO_CATEGORY = {v: k for k, v in CATEGORY_TO_PROJECT.items()}


def _norm_phone(phone: str) -> str:
    """Strip non-digits, keep last 10. Empty string if fewer than 10 digits."""
    digits = re.sub(r"\D", "", phone or "")
    return digits[-10:] if len(digits) >= 10 else ""


def _now_ist_str() -> str:
    return dj_tz.now().astimezone(IST).strftime("%d %b %Y, %I:%M %p IST")


def _build_block(details_html: str, when_str: str) -> str:
    return (
        f"<hr/>\n"
        f"<p><b>{CALL_MARKER} {when_str}</b></p>\n"
        f"{details_html}"
    )


def _sanitize(html: str):
    ok, err, clean = validate_html_content(html)
    if not ok:
        return None, err
    return clean or "", None


def _identifier(issue: Issue) -> str:
    return f"{issue.project.identifier}-{issue.sequence_id}"


def _parse_name(name_field: str):
    """'Caller 9830012345 — Ramesh' -> 'Ramesh'; returns None if no suffix."""
    if not name_field or " — " not in name_field:
        return None
    return name_field.split(" — ", 1)[1].strip() or None


def _short_topic(description_html: str):
    """Newest 'Purpose: X' clause from stored description, trimmed. None if absent.

    Issue.save() rewrites <b> to <strong> and wraps text in editor <p> spans, so
    accept either bold tag and any wrapper attributes.
    """
    matches = re.findall(
        r"<(?:b|strong)[^>]*>\s*Purpose\s*:\s*</(?:b|strong)>\s*([^<]+)",
        description_html or "",
        flags=re.IGNORECASE,
    )
    if not matches:
        return None
    topic = matches[-1].strip().rstrip(".").strip()
    return topic[:60] if topic else None


def _build_greeting(direction, is_returning, caller_name, topic):
    """Plain-text opener for Dograh TTS."""
    name = (caller_name or "").strip()
    if is_returning:
        name_part = f", {name}" if name else ""
        topic_part = f" — last time we spoke about {topic}" if topic else ""
        return (
            f"Welcome back{name_part}! Naina here{topic_part}. "
            "How can I help today?"
        )
    if direction == "outbound":
        name_part = f", {name}" if name else ""
        return (
            f"Hello{name_part}, this is Naina calling on behalf of "
            "Sudipto's businesses. Do you have a quick minute?"
        )
    return (
        "Hello, thanks for calling! This is Naina, the assistant for "
        "Sudipto's businesses. May I know your name, and what you're "
        "calling about today?"
    )


class CallNoteUpsertEndpoint(BaseAPIView):
    """Create or append a call note keyed on (category-project, phone)."""

    def post(self, request, slug):
        phone_raw = request.data.get("phone")
        category = request.data.get("category")
        details_html = request.data.get("details_html")
        caller_name = (request.data.get("caller_name") or "").strip()

        if not phone_raw or not details_html or not category:
            return Response(
                {"error": "phone, category and details_html are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if category not in CATEGORY_TO_PROJECT:
            return Response(
                {"error": f"category must be one of {list(CATEGORY_TO_PROJECT)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        norm = _norm_phone(phone_raw)
        if not norm:
            return Response(
                {"error": "phone must contain at least 10 digits"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        project = Project.objects.filter(
            pk=CATEGORY_TO_PROJECT[category], workspace__slug=slug
        ).first()
        if project is None:
            return Response(
                {"error": f"category '{category}' is not configured for workspace '{slug}'"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        clean_details, err = _sanitize(details_html)
        if err:
            return Response({"error": err}, status=status.HTTP_400_BAD_REQUEST)

        block = _build_block(clean_details, _now_ist_str())

        existing = Issue.objects.filter(
            project_id=project.id,
            external_source=DOGRAH_SOURCE,
            external_id=norm,
        ).first()

        if existing:
            existing.description_html = (existing.description_html or "") + "\n" + block
            existing.updated_by_id = request.user.id
            existing.save(update_fields=["description_html", "updated_by", "updated_at"])
            call_count = (existing.description_html or "").count(CALL_MARKER)
            return Response(
                {
                    "action": "appended",
                    "id": str(existing.id),
                    "identifier": _identifier(existing),
                    "call_count": call_count,
                },
                status=status.HTTP_200_OK,
            )

        name = f"Caller {phone_raw}"
        if caller_name:
            name = f"{name} — {caller_name}"

        issue = Issue(
            name=name[:255],
            description_html=block,
            workspace_id=project.workspace_id,
            project_id=project.id,
            external_source=DOGRAH_SOURCE,
            external_id=norm,
        )
        issue.save(created_by_id=request.user.id)

        return Response(
            {
                "action": "created",
                "id": str(issue.id),
                "identifier": _identifier(issue),
                "call_count": 1,
            },
            status=status.HTTP_200_OK,
        )


class CallNoteLookupEndpoint(BaseAPIView):
    """Find a call-note work-item by phone across all configured projects."""

    def post(self, request, slug):
        phone_raw = (request.data.get("phone") or "").strip()
        direction = "outbound" if request.data.get("direction") == "outbound" else "inbound"
        dialer_name = (request.data.get("caller_name") or "").strip() or None

        norm = _norm_phone(phone_raw) if phone_raw else ""
        issue = None
        if norm:
            issue = (
                Issue.objects
                .filter(
                    workspace__slug=slug,
                    project_id__in=list(CATEGORY_TO_PROJECT.values()),
                    external_source=DOGRAH_SOURCE,
                    external_id=norm,
                )
                .select_related("project")
                .order_by("-updated_at")
                .first()
            )

        if issue is None:
            return Response(
                {
                    "found": False,
                    "is_returning": False,
                    "greeting": _build_greeting(direction, False, dialer_name, None),
                },
                status=status.HTTP_200_OK,
            )

        history = issue.description_html or ""
        caller_name = _parse_name(issue.name)
        return Response(
            {
                "found": True,
                "is_returning": True,
                "greeting": _build_greeting(direction, True, caller_name, _short_topic(history)),
                "id": str(issue.id),
                "identifier": _identifier(issue),
                "category": PROJECT_TO_CATEGORY.get(str(issue.project_id)),
                "caller_name": caller_name,
                "history_html": history,
                "call_count": history.count(CALL_MARKER),
                "last_updated": issue.updated_at.astimezone(IST).isoformat(),
            },
            status=status.HTTP_200_OK,
        )
