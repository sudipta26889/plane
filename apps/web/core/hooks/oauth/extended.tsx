/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// taskpilot imports
import type { TOAuthConfigs } from "@taskpilot/types";

export const useExtendedOAuthConfig = (_oauthActionText: string): TOAuthConfigs => {
  return {
    isOAuthEnabled: false,
    oAuthOptions: [],
  };
};
