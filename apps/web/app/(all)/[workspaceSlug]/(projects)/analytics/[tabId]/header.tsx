/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTranslation } from "@taskpilot/i18n";
import { AnalyticsIcon } from "@taskpilot/propel/icons";
// taskpilot imports
import { Breadcrumbs, Header } from "@taskpilot/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";

export const WorkspaceAnalyticsHeader = observer(function WorkspaceAnalyticsHeader() {
  const { t } = useTranslation();
  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={t("workspace_analytics.label")}
                icon={<AnalyticsIcon className="h-4 w-4 text-tertiary" />}
              />
            }
          />
        </Breadcrumbs>
      </Header.LeftItem>
    </Header>
  );
});
