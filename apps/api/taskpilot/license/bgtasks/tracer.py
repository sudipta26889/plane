# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from celery import shared_task


@shared_task
def instance_traces():
    """No-op: telemetry has been removed."""
    return
