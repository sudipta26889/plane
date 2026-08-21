/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createContext } from "react";
// taskpilot admin store
import { RootStore } from "../store/root.store";

export const rootStore = new RootStore();

export const StoreContext = createContext<RootStore | undefined>(undefined);
