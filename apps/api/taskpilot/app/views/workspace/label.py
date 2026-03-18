# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party modules
from rest_framework import status
from rest_framework.response import Response

# Module imports
from taskpilot.app.serializers import LabelSerializer
from taskpilot.app.views.base import BaseAPIView
from taskpilot.db.models import Label
from taskpilot.app.permissions import WorkspaceViewerPermission
from taskpilot.utils.cache import cache_response


class WorkspaceLabelsEndpoint(BaseAPIView):
    permission_classes = [WorkspaceViewerPermission]
    use_read_replica = True

    @cache_response(60 * 60 * 2)
    def get(self, request, slug):
        labels = Label.objects.filter(
            workspace__slug=slug,
            project__project_projectmember__member=request.user,
            project__project_projectmember__is_active=True,
            project__archived_at__isnull=True,
        )
        serializer = LabelSerializer(labels, many=True).data
        return Response(serializer, status=status.HTTP_200_OK)
