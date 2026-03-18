/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@taskpilot/i18n";
import { EmptyStateCompact } from "@taskpilot/propel/empty-state";

export function StickiesEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex w-full items-center justify-center rounded-lg bg-layer-1 py-10">
      <EmptyStateCompact assetKey="note" assetClassName="size-20" title={t("stickies.empty_state.simple")} />
    </div>
  );
}
