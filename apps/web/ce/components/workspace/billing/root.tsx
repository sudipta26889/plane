/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// taskpilot imports
import { useTranslation } from "@taskpilot/i18n";
// components
import { SettingsBoxedControlItem } from "@/components/settings/boxed-control-item";
import { SettingsHeading } from "@/components/settings/heading";

export const BillingRoot = observer(function BillingRoot() {
  const { t } = useTranslation();

  return (
    <section className="relative scrollbar-hide size-full overflow-y-auto">
      <div>
        <SettingsHeading
          title={t("workspace_settings.settings.billing_and_plans.heading")}
          description="All features are unlocked. No billing required."
        />
        <div className="mt-6">
          <SettingsBoxedControlItem
            title="Self-Hosted"
            description="All features are available. Unlimited projects, work items, cycles, modules, pages, storage, and users."
          />
        </div>
      </div>
    </section>
  );
});
