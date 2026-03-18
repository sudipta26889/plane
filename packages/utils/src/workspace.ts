/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// taskpilot imports
import type { IWorkspace } from "@taskpilot/types";

export const orderWorkspacesList = (workspaces: IWorkspace[]): IWorkspace[] =>
  workspaces.sort((a, b) => a.name.localeCompare(b.name));
