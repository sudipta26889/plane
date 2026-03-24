/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// editor
import type { TExtensions } from "@taskpilot/editor";
import type { EPageStoreType } from "@/taskpilot-web/hooks/store";

export type TEditorFlaggingHookReturnType = {
  document: {
    disabled: TExtensions[];
    flagged: TExtensions[];
  };
  liteText: {
    disabled: TExtensions[];
    flagged: TExtensions[];
  };
  richText: {
    disabled: TExtensions[];
    flagged: TExtensions[];
  };
};

export type TEditorFlaggingHookProps = {
  workspaceSlug: string;
  projectId?: string;
  storeType?: EPageStoreType;
};

/**
 * @description extensions disabled in various editors
 */
export const useEditorFlagging = (_props: TEditorFlaggingHookProps): TEditorFlaggingHookReturnType => ({
  document: {
    disabled: ["collaboration-cursor"],
    flagged: [],
  },
  liteText: {
    disabled: ["collaboration-cursor"],
    flagged: [],
  },
  richText: {
    disabled: ["collaboration-cursor"],
    flagged: [],
  },
});
