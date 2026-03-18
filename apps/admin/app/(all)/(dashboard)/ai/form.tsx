/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useForm, Controller } from "react-hook-form";
import { Lightbulb } from "lucide-react";
import { Button } from "@taskpilot/propel/button";
import { TOAST_TYPE, setToast } from "@taskpilot/propel/toast";
import type { IFormattedInstanceConfiguration, TInstanceAIConfigurationKeys } from "@taskpilot/types";
// components
import type { TControllerInputFormField } from "@/components/common/controller-input";
import { ControllerInput } from "@/components/common/controller-input";
// hooks
import { useInstance } from "@/hooks/store";

type IInstanceAIForm = {
  config: IFormattedInstanceConfiguration;
};

type AIFormValues = Record<TInstanceAIConfigurationKeys, string>;

export function InstanceAIForm(props: IInstanceAIForm) {
  const { config } = props;
  // store
  const { updateInstanceConfigurations } = useInstance();
  // form data
  const {
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<AIFormValues>({
    defaultValues: {
      LLM_API_KEY: config["LLM_API_KEY"],
      LLM_API_BASE_URL: config["LLM_API_BASE_URL"],
      LLM_PROVIDER: config["LLM_PROVIDER"] || "openai",
      LLM_MODEL: config["LLM_MODEL"],
    },
  });

  const LLM_PROVIDER_OPTIONS = [
    { value: "openai", label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "gemini", label: "Gemini" },
  ];

  const aiFormFields: TControllerInputFormField[] = [
    {
      key: "LLM_API_KEY",
      type: "password",
      label: "API key",
      description: "Your LLM provider API key.",
      placeholder: "sk-asddassdfasdefqsdfasd23das3dasdcasd",
      error: Boolean(errors.LLM_API_KEY),
      required: false,
    },
    {
      key: "LLM_API_BASE_URL",
      type: "text",
      label: "API Base URL",
      description: "Custom OpenAI-compatible endpoint URL (e.g., LiteLLM proxy). Leave empty to use the default provider endpoint.",
      placeholder: "http://your-litellm-server:4000",
      error: Boolean(errors.LLM_API_BASE_URL),
      required: false,
    },
    {
      key: "LLM_MODEL",
      type: "text",
      label: "LLM Model",
      description: "The model name to use for AI features (e.g., gpt-4o-mini, claude-sonnet-4-20250514, gemini-pro). Compatible with LiteLLM model naming.",
      placeholder: "gpt-4o-mini",
      error: Boolean(errors.LLM_MODEL),
      required: false,
    },
  ];

  const onSubmit = async (formData: AIFormValues) => {
    const payload: Partial<AIFormValues> = { ...formData };

    await updateInstanceConfigurations(payload)
      .then(() =>
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: "Success",
          message: "AI Settings updated successfully",
        })
      )
      .catch((err) => console.error(err));
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div>
          <div className="pb-1 text-18 font-medium text-primary">AI Configuration</div>
          <div className="text-13 font-regular text-tertiary">Configure your LLM provider settings. Compatible with OpenAI, Anthropic, Gemini, and LiteLLM-compatible endpoints.</div>
        </div>
        <div className="grid-col grid w-full grid-cols-1 items-center justify-between gap-x-12 gap-y-8 lg:grid-cols-3">
          {aiFormFields.map((field) => (
            <ControllerInput
              key={field.key}
              control={control}
              type={field.type}
              name={field.key}
              label={field.label}
              description={field.description}
              placeholder={field.placeholder}
              error={field.error}
              required={field.required}
            />
          ))}
          <div className="flex flex-col gap-1">
            <h4 className="text-13 text-tertiary">LLM Provider</h4>
            <Controller
              control={control}
              name="LLM_PROVIDER"
              render={({ field: { value, onChange, ref } }) => (
                <select
                  id="LLM_PROVIDER"
                  name="LLM_PROVIDER"
                  value={value}
                  onChange={onChange}
                  ref={ref}
                  className="w-full rounded-md border border-custom-border-200 bg-custom-background-100 px-3 py-2 text-sm font-medium text-custom-text-200 focus:border-custom-primary-100 focus:outline-none"
                >
                  {LLM_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            />
            <p className="pt-0.5 text-11 text-tertiary">Select your LLM provider.</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col items-start gap-4">
        <Button variant="primary" size="lg" onClick={handleSubmit(onSubmit)} loading={isSubmitting}>
          {isSubmitting ? "Saving" : "Save changes"}
        </Button>

        <div className="relative inline-flex items-center gap-1.5 rounded-sm border border-accent-subtle bg-accent-subtle px-4 py-2 text-caption-sm-regular text-accent-secondary">
          <Lightbulb className="size-4" />
          <div>
            You can use any OpenAI-compatible endpoint, including LiteLLM, to route requests to your preferred LLM provider.
          </div>
        </div>
      </div>
    </div>
  );
}
