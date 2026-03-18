# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
WSGI config for taskpilot project.

It exposes the WSGI callable as a module-level variable named ``application``.

"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "taskpilot.settings.production")

application = get_wsgi_application()
