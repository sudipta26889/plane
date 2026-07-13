# Generated for /call-notes performance — indexed lookup by
# (external_source, external_id) used by the Dograh voice-agent flow.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("db", "0120_issueview_archived_at"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="issue",
            index=models.Index(
                fields=["external_source", "external_id"],
                name="issue_external_src_id_idx",
            ),
        ),
    ]
