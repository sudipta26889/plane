/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTranslation } from "@taskpilot/i18n";
// ui
import { CycleIcon } from "@taskpilot/propel/icons";
import { Breadcrumbs, Header } from "@taskpilot/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";

export const WorkspaceActiveCycleHeader = observer(function WorkspaceActiveCycleHeader() {
  const { t } = useTranslation();
  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={t("active_cycles")}
                icon={<CycleIcon className="h-4 w-4 rotate-180 text-tertiary" />}
              />
            }
          />
        </Breadcrumbs>
      </Header.LeftItem>
    </Header>
  );
});
