# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from taskpilot.api.views import (
    CallNoteUpsertEndpoint,
    CallNoteLookupEndpoint,
)

urlpatterns = [
    path(
        "workspaces/<str:slug>/call-notes/upsert/",
        CallNoteUpsertEndpoint.as_view(http_method_names=["post"]),
        name="call-note-upsert",
    ),
    path(
        "workspaces/<str:slug>/call-notes/lookup/",
        CallNoteLookupEndpoint.as_view(http_method_names=["post"]),
        name="call-note-lookup",
    ),
]
