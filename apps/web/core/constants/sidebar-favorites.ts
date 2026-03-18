/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { LucideIcon } from "lucide-react";
// taskpilot imports
import type { ISvgIcons } from "@taskpilot/propel/icons";
import { CycleIcon, FavoriteFolderIcon, ModuleIcon, PageIcon, ProjectIcon, ViewsIcon } from "@taskpilot/propel/icons";
import type { IFavorite } from "@taskpilot/types";

export const FAVORITE_ITEM_ICONS: Record<string, React.FC<ISvgIcons> | LucideIcon> = {
  page: PageIcon,
  project: ProjectIcon,
  view: ViewsIcon,
  module: ModuleIcon,
  cycle: CycleIcon,
  folder: FavoriteFolderIcon,
};

export const FAVORITE_ITEM_LINKS: {
  [key: string]: {
    itemLevel: "project" | "workspace";
    getLink: (favorite: IFavorite) => string;
  };
} = {
  project: {
    itemLevel: "project",
    getLink: () => `issues`,
  },
  cycle: {
    itemLevel: "project",
    getLink: (favorite) => `cycles/${favorite.entity_identifier}`,
  },
  module: {
    itemLevel: "project",
    getLink: (favorite) => `modules/${favorite.entity_identifier}`,
  },
  view: {
    itemLevel: "project",
    getLink: (favorite) => `views/${favorite.entity_identifier}`,
  },
  page: {
    itemLevel: "project",
    getLink: (favorite) => `pages/${favorite.entity_identifier}`,
  },
};
