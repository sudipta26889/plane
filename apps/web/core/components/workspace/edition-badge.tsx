/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// ui
import { Tooltip } from "@taskpilot/propel/tooltip";
// hooks
import { usePlatformOS } from "@/hooks/use-platform-os";
import packageJson from "package.json";
import { Button } from "@taskpilot/propel/button";
import { PaidPlanUpgradeModal } from "@/components/license/modal/upgrade-modal";

export const WorkspaceEditionBadge = observer(function WorkspaceEditionBadge() {
  // platform
  const { isMobile } = usePlatformOS();

  return (
    <Tooltip tooltipContent={`Version: v${packageJson.version}`} isMobile={isMobile}>
      <Button
        variant="tertiary"
        size="lg"
      >
        Community
      </Button>
    </Tooltip>
  );
});
