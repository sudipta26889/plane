/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// taskpilot imports
import { MAX_FILE_SIZE } from "@taskpilot/constants";
// hooks
import { useInstance } from "@/hooks/store/use-instance";

type TReturnProps = {
  maxFileSize: number;
};

export const useFileSize = (): TReturnProps => {
  // store hooks
  const { config } = useInstance();

  return {
    maxFileSize: config?.file_size_limit ?? MAX_FILE_SIZE,
  };
};
