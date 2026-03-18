/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { EPageStoreType } from "@/taskpilot-web/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";

export type TPageShareControlProps = {
  page: TPageInstance;
  storeType: EPageStoreType;
};

export function PageShareControl({}: TPageShareControlProps) {
  return null;
}
