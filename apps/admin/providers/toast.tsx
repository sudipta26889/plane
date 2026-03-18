/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTheme } from "next-themes";
import { Toast } from "@taskpilot/propel/toast";
import { resolveGeneralTheme } from "@taskpilot/utils";

export function ToastWithTheme() {
  const { resolvedTheme } = useTheme();
  return <Toast theme={resolveGeneralTheme(resolvedTheme)} />;
}
