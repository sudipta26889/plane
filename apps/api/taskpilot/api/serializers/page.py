# Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db import transaction

# Third party imports
from rest_framework import serializers

# Module imports
from .base import BaseSerializer
from taskpilot.db.models import Label, Page, PageLabel, Project, ProjectPage
from taskpilot.utils.content_validator import validate_html_content


class PageSerializer(BaseSerializer):
    """
    Serializer for pages with metadata fields.

    Handles page metadata (name, access, color, parent, labels, lock and
    archive state) for list responses. Page content is exposed through
    PageDetailSerializer.
    """

    labels = serializers.PrimaryKeyRelatedField(many=True, queryset=Label.objects.all(), required=False)

    class Meta:
        model = Page
        fields = [
            "id",
            "name",
            "access",
            "color",
            "parent",
            "labels",
            "is_locked",
            "archived_at",
            "workspace",
            "view_props",
            "logo_props",
            "external_id",
            "external_source",
            "owned_by",
            "created_at",
            "updated_at",
            "created_by",
            "updated_by",
        ]
        read_only_fields = [
            "id",
            "workspace",
            "owned_by",
            "archived_at",
            "created_at",
            "updated_at",
            "created_by",
            "updated_by",
        ]
        extra_kwargs = {"name": {"required": True, "allow_blank": False}}

    def validate_parent(self, value):
        if value is None:
            return value

        # Reject the page itself and any of its descendants to avoid cycles;
        # track visited ids so a pre-existing cycle in the chain cannot loop forever
        if self.instance:
            visited = set()
            ancestor = value
            while ancestor is not None:
                if ancestor.id == self.instance.id:
                    raise serializers.ValidationError("Parent page cannot be the page itself or one of its descendants")
                if ancestor.id in visited:
                    raise serializers.ValidationError("Parent page hierarchy contains a cycle")
                visited.add(ancestor.id)
                ancestor = ancestor.parent

        # The parent page must belong to the same project
        project_id = self.context.get("project_id") or (
            self.instance and self.instance.project_pages.values_list("project_id", flat=True).first()
        )
        if (
            project_id
            and not ProjectPage.objects.filter(
                page_id=value.id, project_id=project_id, deleted_at__isnull=True
            ).exists()
        ):
            raise serializers.ValidationError("Parent page must belong to the same project")
        return value

    def _sync_labels(self, page, labels):
        # PageLabel carries a workspace, so the m2m cannot be set directly
        PageLabel.objects.filter(page=page).delete()
        PageLabel.objects.bulk_create(
            [
                PageLabel(
                    label=label,
                    page=page,
                    workspace_id=page.workspace_id,
                    created_by_id=page.created_by_id,
                    updated_by_id=page.updated_by_id,
                )
                for label in labels
            ],
            batch_size=10,
        )

    def update(self, instance, validated_data):
        labels = validated_data.pop("labels", None)
        page = super().update(instance, validated_data)
        if labels is not None:
            self._sync_labels(page, labels)
        return page


class PageDetailSerializer(PageSerializer):
    """
    Extended page serializer including the page content.

    Provides the full page representation with description_html and
    description_json for create, retrieve and update operations.
    """

    description_html = serializers.CharField(required=False, allow_blank=True)

    class Meta(PageSerializer.Meta):
        fields = PageSerializer.Meta.fields + ["description_html", "description_json"]

    def validate_description_html(self, value):
        # Validate and sanitize the HTML content for security
        if value:
            is_valid, error_msg, sanitized_html = validate_html_content(value)
            if not is_valid:
                raise serializers.ValidationError(error_msg or "html content is not valid")
            if sanitized_html is not None:
                return sanitized_html
        return value

    def create(self, validated_data):
        project_id = self.context["project_id"]
        owned_by_id = self.context["owned_by_id"]
        labels = validated_data.pop("labels", None)

        # Get the workspace id from the project
        project = Project.objects.get(pk=project_id)

        with transaction.atomic():
            # Create the page
            page = Page.objects.create(
                **validated_data,
                owned_by_id=owned_by_id,
                created_by_id=owned_by_id,
                updated_by_id=owned_by_id,
                workspace_id=project.workspace_id,
            )

            # Create the project page
            ProjectPage.objects.create(
                workspace_id=page.workspace_id,
                project_id=project_id,
                page_id=page.id,
                created_by_id=page.created_by_id,
                updated_by_id=page.updated_by_id,
            )

            if labels:
                self._sync_labels(page, labels)

        return page
