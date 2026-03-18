/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// taskpilot imports
import { ScrollArea } from "@taskpilot/propel/scrollarea";
// local imports
import { ProjectSettingsSidebarHeader } from "./header";
import { ProjectSettingsSidebarItemCategories } from "./item-categories";

type Props = {
  projectId: string;
};

export function ProjectSettingsSidebarRoot(props: Props) {
  const { projectId } = props;

  return (
    <ScrollArea
      scrollType="hover"
      orientation="vertical"
      size="sm"
      rootClassName="shrink-0 animate-fade-in h-full w-[250px] bg-surface-1 border-r border-r-subtle overflow-y-scroll"
      viewportClassName="pb-5"
    >
      <ProjectSettingsSidebarHeader projectId={projectId} />
      <ProjectSettingsSidebarItemCategories projectId={projectId} />
    </ScrollArea>
  );
}
