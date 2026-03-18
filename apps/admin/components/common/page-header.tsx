/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

type TPageHeader = {
  title?: string;
  description?: string;
};

export function PageHeader(props: TPageHeader) {
  const { title = "God Mode - TaskPilot", description = "TaskPilot god mode" } = props;

  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
    </>
  );
}
