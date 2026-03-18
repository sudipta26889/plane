/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssueLayout } from "@taskpilot/constants";
import { ListLayoutIcon, BoardLayoutIcon } from "@taskpilot/propel/icons";
import type { ISvgIcons } from "@taskpilot/propel/icons";

export function IssueLayoutIcon({
  layout,
  size,
  ...props
}: { layout: TIssueLayout; size?: number } & Omit<ISvgIcons, "width" | "height">) {
  const iconProps = {
    ...props,
    ...(size && { width: size, height: size }),
  };

  switch (layout) {
    case "list":
      return <ListLayoutIcon {...iconProps} />;
    case "kanban":
      return <BoardLayoutIcon {...iconProps} />;
    default:
      return null;
  }
}
