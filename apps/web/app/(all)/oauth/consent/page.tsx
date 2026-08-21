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

const MCP_BASE_URL = process.env.VITE_MCP_BASE_URL || "";

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

// Component to display all linked emails for the logged-in user
function UserEmailsDisplay({ userId, primaryEmail, displayName }: { userId: string; primaryEmail: string; displayName: string }) {
  const [linkedEmails, setLinkedEmails] = useState<string[]>([]);

  useEffect(() => {
    if (!userId) return;
    // Fetch linked accounts to get all provider emails
    fetch(`${API_BASE_URL}/api/users/me/accounts/`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : []))
      .then((accounts: Array<{ provider: string; provider_account_id: string; metadata?: { email?: string } }>) => {
        const emails = accounts
          .map((a) => a.metadata?.email)
          .filter((e): e is string => !!e && e !== primaryEmail);
        setLinkedEmails(emails);
      })
      .catch(() => {});
  }, [userId, primaryEmail]);

  return (
    <div className="mb-4 rounded-md border border-subtle bg-surface-2 px-3 py-2.5">
      <div className="text-sm">
        <span className="font-medium text-primary">Signed in as:</span>{" "}
        <span className="text-primary">{displayName}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs text-secondary">
          <span>📧</span> {primaryEmail} <span className="rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-600">primary</span>
        </div>
        {linkedEmails.map((email) => (
          <div key={email} className="flex items-center gap-1.5 text-xs text-secondary">
            <span>📧</span> {email} <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">linked</span>
          </div>
        ))}
      </div>
    </div>
  );
}

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

    // Get session cookie for user validation
    const getCookie = (name: string) => {
      const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
      return match ? match[2] : "";
    };
    const sessionId = getCookie("sessionid") || getCookie("access_token") || "";

    try {
      const response = await fetch(`${MCP_BASE_URL}/oauth/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oauth_state: oauthState,
          workspace_slug: selectedWorkspace,
          scopes: approvedScopes,
          user_token: sessionId,
          user_id: currentUser?.id,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `Authorization failed (${response.status})`);
      }

      const data = await response.json();

      if (data.redirect_url) {
        window.location.href = data.redirect_url;
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
      <div className="flex min-h-screen w-full items-center justify-center bg-surface-2 px-4 py-8">
        <div className="flex w-full max-w-[500px] flex-col rounded-lg border border-subtle bg-surface-1 shadow-sm" style={{ maxHeight: "calc(100vh - 4rem)" }}>
          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-8 pb-4">
            {/* Logo */}
            <div className="mb-4 flex justify-center">
              <TaskPilotLogo className="h-8 w-auto text-primary" />
            </div>

            {/* Heading */}
            <h1 className="mb-1 text-center text-xl font-semibold text-primary">Authorize Access</h1>
            <p className="mb-4 text-center text-sm text-secondary">
              <span className="font-medium text-primary">{oauthPayload.client_name}</span> wants to access your TaskPilot
              account
            </p>

            {/* Logged in user info with all linked emails */}
            {currentUser && (
              <UserEmailsDisplay userId={currentUser.id} primaryEmail={currentUser.email} displayName={currentUser.display_name || currentUser.first_name || ""} />
            )}

            {/* Error message */}
            {error && (
              <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}

            {/* Workspace selector */}
            <div className="mb-4">
              <label htmlFor="workspace-select" className="mb-1.5 block text-sm font-medium text-primary">
                Workspace
              </label>
              <select
                id="workspace-select"
                value={selectedWorkspace}
                onChange={(e) => setSelectedWorkspace(e.target.value)}
                className="w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-sm text-primary outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
              >
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.slug}>
                    {ws.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Permissions */}
            <div className="mb-4">
              <h3 className="mb-3 text-sm font-medium text-primary">Permissions</h3>
              <div className="space-y-2.5">
                {AVAILABLE_SCOPES.map((scope) => (
                  <label key={scope.key} className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={checkedScopes[scope.key] ?? false}
                      onChange={() => handleScopeToggle(scope.key)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400"
                    />
                    <span className="text-sm text-primary">{scope.label}</span>
                    <span className="text-xs text-secondary">({scope.key})</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Info text */}
            <p className="text-center text-xs text-secondary">
              You can revoke access at any time in your account settings.
            </p>
          </div>

          {/* Action buttons — always visible at bottom */}
          <div className="flex shrink-0 items-center gap-3 border-t border-subtle bg-surface-1 px-8 py-4">
            <button
              type="button"
              onClick={handleDeny}
              disabled={isSubmitting}
              className="flex-1 rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={handleAuthorize}
              disabled={isSubmitting || !selectedWorkspace}
              className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
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
