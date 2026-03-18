/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { AlertOctagon, BarChart4, CircleDashed, Folder, Microscope } from "lucide-react";
// taskpilot imports
import { MARKETING_PRICING_PAGE_LINK } from "@taskpilot/constants";
import { useTranslation } from "@taskpilot/i18n";
import { getButtonStyling } from "@taskpilot/propel/button";
import { SearchIcon } from "@taskpilot/propel/icons";
import { ContentWrapper } from "@taskpilot/ui";
import { cn } from "@taskpilot/utils";
// assets
import ctaL1Dark from "@/app/assets/workspace-active-cycles/cta-l-1-dark.webp?url";
import ctaL1Light from "@/app/assets/workspace-active-cycles/cta-l-1-light.webp?url";
import ctaR1Dark from "@/app/assets/workspace-active-cycles/cta-r-1-dark.webp?url";
import ctaR1Light from "@/app/assets/workspace-active-cycles/cta-r-1-light.webp?url";
import ctaR2Dark from "@/app/assets/workspace-active-cycles/cta-r-2-dark.webp?url";
import ctaR2Light from "@/app/assets/workspace-active-cycles/cta-r-2-light.webp?url";
// components
import { ProIcon } from "@/components/common/pro-icon";
// hooks
import { useUser } from "@/hooks/store/user";

export const WORKSPACE_ACTIVE_CYCLES_DETAILS = [
  {
    key: "10000_feet_view",
    title: "10,000-feet view of all active cycles.",
    description:
      "Zoom out to see running cycles across all your projects at once instead of going from Cycle to Cycle in each project.",
    icon: Folder,
  },
  {
    key: "get_snapshot_of_each_active_cycle",
    title: "Get a snapshot of each active cycle.",
    description:
      "Track high-level metrics for all active cycles, see their state of progress, and get a sense of scope against deadlines.",
    icon: CircleDashed,
  },
  {
    key: "compare_burndowns",
    title: "Compare burndowns.",
    description: "Monitor how each of your teams are performing with a peek into each cycle’s burndown report.",
    icon: BarChart4,
  },
  {
    key: "quickly_see_make_or_break_issues",
    title: "Quickly see make-or-break work items. ",
    description:
      "Preview high-priority work items for each cycle against due dates. See all of them per cycle in one click.",
    icon: AlertOctagon,
  },
  {
    key: "zoom_into_cycles_that_need_attention",
    title: "Zoom into cycles that need attention. ",
    description: "Investigate the state of any cycle that doesn’t conform to expectations in one click.",
    icon: SearchIcon,
  },
  {
    key: "stay_ahead_of_blockers",
    title: "Stay ahead of blockers.",
    description:
      "Spot challenges from one project to another and see inter-cycle dependencies that aren’t obvious from any other view.",
    icon: Microscope,
  },
];

export const WorkspaceActiveCyclesUpgrade = observer(function WorkspaceActiveCyclesUpgrade() {
  return null;
});
