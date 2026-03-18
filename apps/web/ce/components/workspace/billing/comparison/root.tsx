/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// taskpilot imports
import type { EProductSubscriptionEnum, TBillingFrequency } from "@taskpilot/types";
// components
import { PlansComparisonBase, shouldRenderPlanDetail } from "@/components/workspace/billing/comparison/base";
import type { TTaskPilotPlans } from "@/constants/plans";
import { TASKPILOT_PLANS } from "@/constants/plans";
// taskpilot web imports
import { PlanDetail } from "./plan-detail";

type TPlansComparisonProps = {
  isCompareAllFeaturesSectionOpen: boolean;
  getBillingFrequency: (subscriptionType: EProductSubscriptionEnum) => TBillingFrequency | undefined;
  setBillingFrequency: (subscriptionType: EProductSubscriptionEnum, frequency: TBillingFrequency) => void;
  setIsCompareAllFeaturesSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export const PlansComparison = observer(function PlansComparison(props: TPlansComparisonProps) {
  const {
    isCompareAllFeaturesSectionOpen,
    getBillingFrequency,
    setBillingFrequency,
    setIsCompareAllFeaturesSectionOpen,
  } = props;
  // plan details
  const { planDetails } = TASKPILOT_PLANS;

  return (
    <PlansComparisonBase
      taskpilotDetails={Object.entries(planDetails).map(([planKey, plan]) => {
        const currentPlanKey = planKey as TTaskPilotPlans;
        if (!shouldRenderPlanDetail(currentPlanKey)) return null;
        return (
          <PlanDetail
            key={planKey}
            subscriptionType={plan.id}
            planDetail={plan}
            billingFrequency={getBillingFrequency(plan.id)}
            setBillingFrequency={(frequency) => setBillingFrequency(plan.id, frequency)}
          />
        );
      })}
      isSelfManaged
      isCompareAllFeaturesSectionOpen={isCompareAllFeaturesSectionOpen}
      setIsCompareAllFeaturesSectionOpen={setIsCompareAllFeaturesSectionOpen}
    />
  );
});
