/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { useTranslation } from "@taskpilot/i18n";
import { getAnalyticsTabs } from "./tabs";

export const useAnalyticsTabs = (workspaceSlug: string) => {
  const { t } = useTranslation();

  const analyticsTabs = useMemo(() => getAnalyticsTabs(t), [t]);

  return analyticsTabs;
};
