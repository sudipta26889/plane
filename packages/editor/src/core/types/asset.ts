/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// constants
import type { CORE_EXTENSIONS } from "@/constants/extension";
// taskpilot editor imports
import type { TAdditionalEditorAsset } from "@/taskpilot-editor/types/asset";

export type TEditorImageAsset = {
  href: string;
  id: string;
  name: string;
  src: string;
  type: CORE_EXTENSIONS.IMAGE | CORE_EXTENSIONS.CUSTOM_IMAGE;
};

export type TEditorAsset = TEditorImageAsset | TAdditionalEditorAsset;
