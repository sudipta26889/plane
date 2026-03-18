/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { PROJECT_TRACKER_ELEMENTS } from "@taskpilot/constants";
import { ChevronRightIcon } from "@taskpilot/propel/icons";
import { EPillVariant, Pill, EPillSize } from "@taskpilot/propel/pill";
import { ToggleSwitch } from "@taskpilot/ui";
import { joinUrlPath } from "@taskpilot/utils";

type Props = {
  workspaceSlug: string;
  projectId: string;
  featureItem: any;
  value: boolean;
  handleSubmit: (featureKey: string, featureProperty: string) => void;
  disabled?: boolean;
};

export function ProjectFeatureToggle(props: Props) {
  const { workspaceSlug, projectId, featureItem, value, handleSubmit, disabled } = props;
  return featureItem?.href ? (
    <Link href={joinUrlPath(workspaceSlug, "settings", "projects", projectId, "features", featureItem?.href)}>
      <div className="flex items-center gap-2">
        <Pill
          variant={value ? EPillVariant.PRIMARY : EPillVariant.DEFAULT}
          size={EPillSize.SM}
          className="rounded-lg border-none"
        >
          {value ? "Enabled" : "Disabled"}
        </Pill>
        <ChevronRightIcon className="h-4 w-4 text-tertiary" />
      </div>
    </Link>
  ) : (
    <ToggleSwitch
      value={value}
      onChange={() => handleSubmit(featureItem?.key, featureItem?.property)}
      disabled={disabled}
      size="sm"
      data-ph-element={PROJECT_TRACKER_ELEMENTS.TOGGLE_FEATURE}
    />
  );
}
