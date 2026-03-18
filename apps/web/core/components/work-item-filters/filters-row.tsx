/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// taskpilot imports
import type { IWorkItemFilterInstance } from "@taskpilot/shared-state";
import type { TWorkItemFilterExpression, TWorkItemFilterProperty } from "@taskpilot/types";
// components
import type { TFiltersRowProps } from "@/components/rich-filters/filters-row";
import { FiltersRow } from "@/components/rich-filters/filters-row";

type TWorkItemFiltersRowProps = TFiltersRowProps<TWorkItemFilterProperty, TWorkItemFilterExpression> & {
  filter: IWorkItemFilterInstance;
};

export const WorkItemFiltersRow = observer(function WorkItemFiltersRow(props: TWorkItemFiltersRowProps) {
  return <FiltersRow {...props} />;
});
