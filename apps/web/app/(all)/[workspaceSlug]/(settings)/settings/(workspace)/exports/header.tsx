/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// taskpilot imports
import { WORKSPACE_SETTINGS } from "@taskpilot/constants";
import { useTranslation } from "@taskpilot/i18n";
import { Breadcrumbs } from "@taskpilot/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { WORKSPACE_SETTINGS_ICONS } from "@/components/settings/workspace/sidebar/item-icon";

export const ExportsWorkspaceSettingsHeader = observer(function ExportsWorkspaceSettingsHeader() {
  // translation
  const { t } = useTranslation();
  // derived values
  const settingsDetails = WORKSPACE_SETTINGS.export;
  const Icon = WORKSPACE_SETTINGS_ICONS.export;

  return (
    <SettingsPageHeader
      leftItem={
        <div className="flex items-center gap-2">
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  label={t(settingsDetails.i18n_label)}
                  icon={<Icon className="size-4 text-tertiary" />}
                />
              }
            />
          </Breadcrumbs>
        </div>
      }
    />
  );
});
