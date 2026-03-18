/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { Button } from "@taskpilot/propel/button";
// assets
import TaskPilotTakeOffImage from "@/app/assets/images/taskpilot-takeoff.png?url";

export function InstanceNotReady() {
  return (
    <div className="relative container mx-auto flex h-full w-full items-center justify-center px-5">
      <div className="relative w-auto max-w-2xl space-y-8 py-10">
        <div className="relative flex flex-col items-center justify-center space-y-4">
          <h1 className="pb-3 text-24 font-bold">Welcome aboard TaskPilot!</h1>
          <img src={TaskPilotTakeOffImage} alt="TaskPilot Logo" />
          <p className="text-14 font-medium text-placeholder">Get started by setting up your instance and workspace</p>
        </div>

        <div>
          <Link href={"/setup/?auth_enabled=0"}>
            <Button size="xl" className="w-full">
              Get started
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
