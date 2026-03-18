/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// editor
import type { TEmbedConfig } from "@taskpilot/editor";
// taskpilot types
import type { TSearchEntityRequestPayload, TSearchResponse } from "@taskpilot/types";
// taskpilot web components
import { IssueEmbedUpgradeCard } from "@/taskpilot-web/components/pages";

export type TIssueEmbedHookProps = {
  fetchEmbedSuggestions?: (payload: TSearchEntityRequestPayload) => Promise<TSearchResponse>;
  projectId?: string;
  workspaceSlug?: string;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const useIssueEmbed = (props: TIssueEmbedHookProps) => {
  const widgetCallback = () => <IssueEmbedUpgradeCard />;

  const issueEmbedProps: TEmbedConfig["issue"] = {
    widgetCallback,
  };

  return {
    issueEmbedProps,
  };
};
