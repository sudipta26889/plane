/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
// taskpilot imports
import { PROFILE_VIEWER_TAB, PROFILE_ADMINS_TAB } from "@taskpilot/constants";
import { useTranslation } from "@taskpilot/i18n";
import { Header, EHeaderVariant } from "@taskpilot/ui";
import { cn } from "@taskpilot/utils";

type Props = {
  isAuthorized: boolean;
};

export function ProfileNavbar(props: Props) {
  const { isAuthorized } = props;
  const { t } = useTranslation();
  const { workspaceSlug, userId } = useParams();
  const pathname = usePathname();

  const tabsList = isAuthorized ? [...PROFILE_VIEWER_TAB, ...PROFILE_ADMINS_TAB] : PROFILE_VIEWER_TAB;

  return (
    <Header variant={EHeaderVariant.SECONDARY} showOnMobile={false}>
      <div className="flex items-center overflow-x-scroll">
        {tabsList.map((tab) => (
          <Link key={tab.route} href={`/${workspaceSlug}/profile/${userId}/${tab.route}`}>
            <span
              className={cn(
                `flex border-b-2 p-4 text-13 font-medium whitespace-nowrap text-tertiary outline-none hover:text-primary ${
                  pathname === `/${workspaceSlug}/profile/${userId}${tab.selected}`
                    ? "border-accent-strong text-accent-primary hover:text-accent-primary"
                    : "border-transparent"
                }`
              )}
            >
              {t(tab.i18n_label)}
            </span>
          </Link>
        ))}
      </div>
    </Header>
  );
}
