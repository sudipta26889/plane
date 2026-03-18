/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { TaskPilotLockup } from "@taskpilot/propel/icons";

export function AuthHeader() {
  return (
    <div className="sticky top-0 flex w-full flex-shrink-0 items-center justify-between gap-6">
      <Link href="/">
        <TaskPilotLockup height={20} width={95} className="text-primary" />
      </Link>
    </div>
  );
}
