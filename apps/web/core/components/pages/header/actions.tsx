/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// taskpilot web components
import { PageLockControl } from "@/taskpilot-web/components/pages/header/lock-control";
import { PageMoveControl } from "@/taskpilot-web/components/pages/header/move-control";
import { PageShareControl } from "@/taskpilot-web/components/pages/header/share-control";
// taskpilot web hooks
import type { EPageStoreType } from "@/taskpilot-web/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";
// local imports
import { PageOptionsDropdown } from "../editor/toolbar";
import { PageArchivedBadge } from "./archived-badge";
import { PageCopyLinkControl } from "./copy-link-control";
import { PageFavoriteControl } from "./favorite-control";
import { PageOfflineBadge } from "./offline-badge";

type Props = {
  page: TPageInstance;
  storeType: EPageStoreType;
};

export const PageHeaderActions = observer(function PageHeaderActions(props: Props) {
  const { page, storeType } = props;

  return (
    <div className="flex items-center gap-1">
      <PageArchivedBadge page={page} />
      <PageOfflineBadge page={page} />
      <PageLockControl page={page} />
      <PageMoveControl page={page} />
      <PageCopyLinkControl page={page} />
      <PageFavoriteControl page={page} />
      <PageShareControl page={page} storeType={storeType} />
      <PageOptionsDropdown page={page} storeType={storeType} />
    </div>
  );
});
