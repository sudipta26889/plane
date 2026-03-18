/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const taskpilotTheme = create({
  base: "dark",
  brandTitle: "TaskPilot UI",
  brandUrl: "",
  brandImage: "taskpilot-lockup-light.svg",
  brandTarget: "_self",
});

addons.setConfig({
  theme: taskpilotTheme,
});
