# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Module imports
from taskpilot.license.models import Instance
from taskpilot.app.serializers import BaseSerializer
from taskpilot.app.serializers import UserAdminLiteSerializer


class InstanceSerializer(BaseSerializer):
    primary_owner_details = UserAdminLiteSerializer(source="primary_owner", read_only=True)

    class Meta:
        model = Instance
        fields = "__all__"
        read_only_fields = ["id", "email", "last_checked_at", "is_setup_done"]
