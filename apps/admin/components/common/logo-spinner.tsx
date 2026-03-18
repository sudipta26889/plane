/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export function LogoSpinner() {
  return (
    <div className="flex items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-custom-primary/20 border-t-custom-primary sm:h-12 sm:w-12" />
    </div>
  );
}
