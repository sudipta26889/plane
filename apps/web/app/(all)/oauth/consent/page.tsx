/**
 * Copyright (c) 2023-present TaskPilot Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
// ui
import { TaskPilotLogo } from "@taskpilot/propel/icons";
import { API_BASE_URL } from "@taskpilot/constants";
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
// hooks
import { useUser } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
// layouts
import DefaultLayout from "@/layouts/default-layout";

const MCP_BASE_URL = process.env.VITE_MCP_BASE_URL || "https://taskpilot-mcp.sudiptadhara.in";

type TOAuthStatePayload = {
  client_name: string;
  scope: string;
  redirect_uri: string;
  state: string;
};

type TWorkspace = {
  id: string;
  name: string;
  slug: string;
  logo?: string;
};

const AVAILABLE_SCOPES = [
  { key: "taskpilot:read", label: "Read projects and tasks", defaultChecked: true },
  { key: "taskpilot:write", label: "Create and manage tasks", defaultChecked: true },
  { key: "taskpilot:manage", label: "Manage cycles and modules", defaultChecked: true },
  { key: "taskpilot:delete", label: "Delete tasks and data", defaultChecked: false },
] as const;

const OAuthConsentPage = observer(function OAuthConsentPage() {
  const router = useAppRouter();
  const searchParams = useSearchParams();
  // store hooks
  const { isLoading: isUserLoading, data: currentUser, fetchCurrentUser } = useUser();
  // local state
  const [workspaces, setWorkspaces] = useState<TWorkspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [checkedScopes, setCheckedScopes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(AVAILABLE_SCOPES.map((s) => [s.key, s.defaultChecked]))
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // get and decode oauth_state
  const oauthState = searchParams.get("oauth_state") ?? "";

  const oauthPayload = useMemo<TOAuthStatePayload | null>(() => {
    if (!oauthState) return null;
    try {
      const decoded = atob(oauthState);
      return JSON.parse(decoded) as TOAuthStatePayload;
    } catch {
      return null;
    }
  }, [oauthState]);

  // fetch current user on mount
  useEffect(() => {
    fetchCurrentUser().catch(() => {
      // user not logged in — redirect to sign-in with return URL
      const returnUrl = `/oauth/consent?oauth_state=${encodeURIComponent(oauthState)}`;
      router.push(`/?next_path=${encodeURIComponent(returnUrl)}`);
    });
  }, []);

  // redirect if not logged in after loading
  useEffect(() => {
    if (!isUserLoading && !currentUser?.id && oauthState) {
      const returnUrl = `/oauth/consent?oauth_state=${encodeURIComponent(oauthState)}`;
      router.push(`/?next_path=${encodeURIComponent(returnUrl)}`);
    }
  }, [isUserLoading, currentUser, oauthState, router]);

  // fetch workspaces once user is loaded
  useEffect(() => {
    if (!currentUser?.id) return;

    setIsLoadingWorkspaces(true);
    fetch(`${API_BASE_URL}/api/users/me/workspaces/`, {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch workspaces");
        return res.json();
      })
      .then((data: TWorkspace[]) => {
        setWorkspaces(data);
        if (data.length > 0) {
          setSelectedWorkspace(data[0].slug);
        }
      })
      .catch(() => {
        setError("Failed to load workspaces. Please try again.");
      })
      .finally(() => {
        setIsLoadingWorkspaces(false);
      });
  }, [currentUser?.id]);

  const handleScopeToggle = useCallback((scopeKey: string) => {
    setCheckedScopes((prev) => ({ ...prev, [scopeKey]: !prev[scopeKey] }));
  }, []);

  const handleDeny = useCallback(() => {
    if (!oauthPayload) return;
    const redirectUrl = new URL(oauthPayload.redirect_uri);
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("state", oauthPayload.state);
    window.location.href = redirectUrl.toString();
  }, [oauthPayload]);

  const handleAuthorize = useCallback(async () => {
    if (!oauthPayload || !selectedWorkspace) return;

    setIsSubmitting(true);
    setError(null);

    const approvedScopes = Object.entries(checkedScopes)
      .filter(([, checked]) => checked)
      .map(([key]) => key);

    try {
      const response = await fetch(`${MCP_BASE_URL}/oauth/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          oauth_state: oauthState,
          workspace_slug: selectedWorkspace,
          scopes: approvedScopes,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Authorization failed");
      }

      const data = await response.json();

      if (data.redirect_uri) {
        window.location.href = data.redirect_uri;
      } else if (data.code) {
        const redirectUrl = new URL(oauthPayload.redirect_uri);
        redirectUrl.searchParams.set("code", data.code);
        redirectUrl.searchParams.set("state", oauthPayload.state);
        window.location.href = redirectUrl.toString();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }, [oauthPayload, oauthState, selectedWorkspace, checkedScopes]);

  // loading state
  if (isUserLoading || isLoadingWorkspaces) {
    return (
      <DefaultLayout>
        <div className="relative flex h-screen w-full items-center justify-center">
          <LogoSpinner />
        </div>
      </DefaultLayout>
    );
  }

  // invalid oauth_state
  if (!oauthPayload) {
    return (
      <DefaultLayout>
        <div className="flex h-screen w-full items-center justify-center">
          <div className="w-full max-w-[500px] rounded-lg border border-subtle bg-surface-1 p-8 text-center shadow-sm">
            <TaskPilotLogo className="mx-auto mb-4 h-8 w-auto text-primary" />
            <h2 className="text-16 font-semibold text-primary">Invalid Authorization Request</h2>
            <p className="mt-2 text-13 text-secondary">
              The authorization request is missing or invalid. Please try again from the application.
            </p>
          </div>
        </div>
      </DefaultLayout>
    );
  }

  return (
    <DefaultLayout>
      <div className="flex h-screen w-full items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-[500px] rounded-lg border border-subtle bg-surface-1 p-8 shadow-sm">
          {/* Logo */}
          <div className="mb-6 flex justify-center">
            <TaskPilotLogo className="h-8 w-auto text-primary" />
          </div>

          {/* Heading */}
          <h1 className="mb-2 text-center text-18 font-semibold text-primary">Authorize Access</h1>
          <p className="mb-6 text-center text-13 text-secondary">
            <span className="font-medium text-primary">{oauthPayload.client_name}</span> wants to access your TaskPilot
            account
          </p>

          {/* Error message */}
          {error && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-13 text-red-700">{error}</div>
          )}

          {/* Workspace selector */}
          <div className="mb-6">
            <label htmlFor="workspace-select" className="mb-1.5 block text-13 font-medium text-primary">
              Workspace
            </label>
            <select
              id="workspace-select"
              value={selectedWorkspace}
              onChange={(e) => setSelectedWorkspace(e.target.value)}
              className="w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary outline-none focus:border-custom-primary-100 focus:ring-1 focus:ring-custom-primary-100"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.slug}>
                  {ws.name}
                </option>
              ))}
            </select>
          </div>

          {/* Permissions */}
          <div className="mb-6">
            <h3 className="mb-3 text-13 font-medium text-primary">Permissions</h3>
            <div className="space-y-3">
              {AVAILABLE_SCOPES.map((scope) => (
                <label key={scope.key} className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={checkedScopes[scope.key] ?? false}
                    onChange={() => handleScopeToggle(scope.key)}
                    className="h-4 w-4 rounded border-subtle text-custom-primary-100 focus:ring-custom-primary-100"
                  />
                  <span className="text-13 text-primary">{scope.label}</span>
                  <span className="text-11 text-secondary">({scope.key})</span>
                </label>
              ))}
            </div>
          </div>

          {/* Info text */}
          <p className="mb-6 text-center text-11 text-secondary">
            You can revoke access at any time in your account settings.
          </p>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleDeny}
              disabled={isSubmitting}
              className="flex-1 rounded-md border border-subtle bg-surface-1 px-4 py-2 text-13 font-medium text-primary transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={handleAuthorize}
              disabled={isSubmitting || !selectedWorkspace}
              className="flex-1 rounded-md bg-custom-primary-100 px-4 py-2 text-13 font-medium text-white transition-colors hover:bg-custom-primary-200 disabled:opacity-50"
            >
              {isSubmitting ? "Authorizing..." : "Authorize"}
            </button>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
});

export default OAuthConsentPage;
