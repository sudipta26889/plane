/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import * as React from "react";

import type { ISvgIcons } from "../type";

export function TaskPilotLogo({ width = "85", height = "52", className }: ISvgIcons) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 85 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <g transform="translate(8, 2)">
        {/* Paper plane body */}
        <path d="M0 38L32 0L68 20L0 38Z" fill="#4DD0E1" />
        {/* Paper plane fold */}
        <path d="M32 0L30 26L0 38L32 0Z" fill="#00ACC1" />
        {/* Paper plane tip */}
        <path d="M32 0L68 20L30 26L32 0Z" fill="#26C6DA" />
        {/* Arrow/cursor accent */}
        <path d="M20 18L38 8L36 22L28 28L20 18Z" fill="#0D2137" />
        {/* Checkmark */}
        <path d="M8 36L16 30L22 38L30 24L36 28L22 48L8 36Z" fill="#00ACC1" opacity="0.8" />
      </g>
    </svg>
  );
}
