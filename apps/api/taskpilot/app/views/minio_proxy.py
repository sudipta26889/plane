# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Proxy view for MinIO S3 requests.
Forwards /{bucket}/* requests to the internal MinIO server so that
presigned URLs work without exposing MinIO to the public internet.
"""

import os

import requests as http_requests
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt


@method_decorator(csrf_exempt, name="dispatch")
class MinioProxyView(View):
    """Proxy requests to the internal MinIO server with CORS support."""

    def _add_cors_headers(self, response, request):
        origin = request.META.get("HTTP_ORIGIN", "*")
        response["Access-Control-Allow-Origin"] = origin
        response["Access-Control-Allow-Methods"] = "GET, POST, PUT, HEAD, OPTIONS"
        response["Access-Control-Allow-Headers"] = (
            "Content-Type, Authorization, X-Amz-Date, X-Amz-Algorithm, "
            "X-Amz-Credential, X-Amz-Signature, X-Amz-SignedHeaders, "
            "X-Amz-Content-Sha256, Accept, Origin"
        )
        response["Access-Control-Max-Age"] = "3600"
        return response

    def options(self, request, path=""):
        """Handle CORS preflight requests."""
        response = HttpResponse(status=204)
        return self._add_cors_headers(response, request)

    def _proxy(self, request, path):
        minio_url = os.environ.get(
            "AWS_S3_ENDPOINT_URL", "http://nas.lan:7612"
        )
        # Use the raw request path to preserve URL encoding
        raw_path = request.META.get("RAW_URI", "") or request.get_full_path()
        target_url = f"{minio_url}{raw_path.split('?')[0]}"

        if request.META.get("QUERY_STRING"):
            target_url += f"?{request.META['QUERY_STRING']}"

        headers = {}
        for key, value in request.META.items():
            if key.startswith("HTTP_") and key not in (
                "HTTP_HOST",
                "HTTP_CONNECTION",
                "HTTP_ORIGIN",
                "HTTP_REFERER",
            ):
                header_name = key[5:].replace("_", "-")
                headers[header_name] = value
        if request.content_type:
            headers["Content-Type"] = request.content_type

        try:
            # For POST/PUT, forward the raw body with the original content type
            body = None
            if request.method in ("POST", "PUT"):
                body = request.body
                # Ensure we send the exact Content-Type with boundary
                ct = request.META.get("CONTENT_TYPE", "")
                if ct:
                    headers["Content-Type"] = ct

            resp = http_requests.request(
                method=request.method,
                url=target_url,
                headers=headers,
                data=body,
                stream=True,
                timeout=300,
            )

            response = HttpResponse(
                resp.raw.read(),
                status=resp.status_code,
                content_type=resp.headers.get(
                    "Content-Type", "application/octet-stream"
                ),
            )

            # Forward relevant headers
            for header in (
                "ETag",
                "Content-Length",
                "Last-Modified",
                "Accept-Ranges",
                "Content-Disposition",
            ):
                if header in resp.headers:
                    response[header] = resp.headers[header]

            return self._add_cors_headers(response, request)
        except Exception:
            response = HttpResponse("MinIO proxy error", status=502)
            return self._add_cors_headers(response, request)

    def get(self, request, path=""):
        return self._proxy(request, path)

    def post(self, request, path=""):
        return self._proxy(request, path)

    def put(self, request, path=""):
        return self._proxy(request, path)

    def head(self, request, path=""):
        return self._proxy(request, path)
