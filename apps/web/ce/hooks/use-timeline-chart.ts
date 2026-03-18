/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// types
import type { TTimelineTypeCore } from "@taskpilot/types";
import { GANTT_TIMELINE_TYPE } from "@taskpilot/types";
// TaskPilot-web

import type { IBaseTimelineStore } from "@/taskpilot-web/store/timeline/base-timeline.store";
import type { ITimelineStore } from "../store/timeline";

export const getTimelineStore = (
  timelineStore: ITimelineStore,
  timelineType: TTimelineTypeCore
): IBaseTimelineStore => {
  if (timelineType === GANTT_TIMELINE_TYPE.ISSUE) {
    return timelineStore.issuesTimeLineStore as IBaseTimelineStore;
  }
  if (timelineType === GANTT_TIMELINE_TYPE.MODULE) {
    return timelineStore.modulesTimeLineStore as IBaseTimelineStore;
  }
  if (timelineType === GANTT_TIMELINE_TYPE.PROJECT) {
    return timelineStore.projectTimeLineStore;
  }
  if (timelineType === GANTT_TIMELINE_TYPE.GROUPED) {
    return timelineStore.groupedTimeLineStore;
  }
  throw new Error(`Unknown timeline type: ${timelineType}`);
};
