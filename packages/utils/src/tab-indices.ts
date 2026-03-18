/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// taskpilot imports
import type { ETabIndices } from "@taskpilot/constants";
import { TAB_INDEX_MAP } from "@taskpilot/constants";

export const getTabIndex = (type?: ETabIndices, isMobile: boolean = false) => {
  const getIndex = (key: string) =>
    isMobile ? undefined : type && TAB_INDEX_MAP[type].findIndex((tabIndex) => tabIndex === key) + 1;

  const baseTabIndex = isMobile ? -1 : 1;

  return { getIndex, baseTabIndex };
};
