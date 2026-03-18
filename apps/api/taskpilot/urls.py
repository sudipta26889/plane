# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""taskpilot URL Configuration"""

from django.conf import settings
from django.urls import include, path, re_path
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularRedocView,
    SpectacularSwaggerView,
)

handler404 = "taskpilot.app.views.error_404.custom_404_view"

# MinIO proxy — must be before catch-all routes
from taskpilot.app.views.minio_proxy import MinioProxyView

bucket_name = settings.AWS_S3_BUCKET_NAME if hasattr(settings, "AWS_S3_BUCKET_NAME") else "taskpilot"

urlpatterns = [
    re_path(rf"^{bucket_name}$", MinioProxyView.as_view(), name="minio_proxy_root"),
    re_path(rf"^{bucket_name}/(?P<path>.*)$", MinioProxyView.as_view(), name="minio_proxy"),
    path("api/", include("taskpilot.app.urls")),
    path("api/public/", include("taskpilot.space.urls")),
    path("api/instances/", include("taskpilot.license.urls")),
    path("api/v1/", include("taskpilot.api.urls")),
    path("auth/", include("taskpilot.authentication.urls")),
    path("", include("taskpilot.web.urls")),
]

if settings.ENABLE_DRF_SPECTACULAR:
    urlpatterns += [
        path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
        path(
            "api/schema/swagger-ui/",
            SpectacularSwaggerView.as_view(url_name="schema"),
            name="swagger-ui",
        ),
        path(
            "api/schema/redoc/",
            SpectacularRedocView.as_view(url_name="schema"),
            name="redoc",
        ),
    ]

if settings.DEBUG:
    try:
        import debug_toolbar

        urlpatterns = [re_path(r"^__debug__/", include(debug_toolbar.urls))] + urlpatterns
    except ImportError:
        pass
