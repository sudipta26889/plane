/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// taskpilot types
import type { IProjectView } from "@taskpilot/types";
import { Spinner } from "@taskpilot/ui";
// components
import type { TPowerKContext } from "@/components/power-k/core/types";
// hooks
import { PowerKViewsMenu } from "@/components/power-k/menus/views";
import { useProjectView } from "@/hooks/store/use-project-view";

type Props = {
  context: TPowerKContext;
  handleSelect: (view: IProjectView) => void;
};

export const PowerKOpenProjectViewsMenu = observer(function PowerKOpenProjectViewsMenu(props: Props) {
  const { context, handleSelect } = props;
  // store hooks
  const { fetchedMap, getProjectViews } = useProjectView();
  // derived values
  const projectId = context.params.projectId?.toString();
  const isFetched = projectId ? fetchedMap[projectId] : false;
  const viewsList = projectId ? (getProjectViews(projectId)?.filter((view) => !!view) ?? []) : [];

  if (!isFetched) return <Spinner />;

  return <PowerKViewsMenu views={viewsList} onSelect={handleSelect} />;
});
