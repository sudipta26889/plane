/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FC } from "react";
import React from "react";
import type { IIssueDisplayProperties, TIssue } from "@taskpilot/types";

export type TWorkItemLayoutAdditionalProperties = {
  displayProperties: IIssueDisplayProperties;
  issue: TIssue;
};

export function WorkItemLayoutAdditionalProperties(props: TWorkItemLayoutAdditionalProperties) {
  return <></>;
}
