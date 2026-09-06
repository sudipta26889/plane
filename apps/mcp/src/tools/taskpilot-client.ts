import { config } from "../config.js";
import { db } from "../db.js";
import crypto from "node:crypto";

/**
 * Get or create a TaskPilot API token for a user+workspace.
 * Since the MCP server shares the same database as the Django API,
 * we can query/create api_tokens directly — no separate API key config needed.
 */
export async function getOrCreateApiToken(userId: string, workspaceSlug: string): Promise<string> {
  // Look up workspace_id from slug
  const wsResult = await db.query(
    `SELECT id FROM workspaces WHERE slug = $1`,
    [workspaceSlug],
  );
  if (wsResult.rows.length === 0) {
    throw new Error(`Workspace not found: ${workspaceSlug}`);
  }
  const workspaceId = wsResult.rows[0].id;

  // Check for existing active token for this user+workspace
  const existing = await db.query(
    `SELECT token FROM api_tokens
     WHERE user_id = $1 AND workspace_id = $2 AND is_active = true
       AND (expired_at IS NULL OR expired_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [userId, workspaceId],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].token;
  }

  // Create a new API token for this user+workspace
  const token = `taskpilot_api_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.query(
    `INSERT INTO api_tokens (id, token, label, description, user_id, workspace_id, user_type, is_active, is_service, allowed_rate_limit, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, true, false, '300/min', NOW(), NOW())`,
    [
      crypto.randomUUID(),
      token,
      `mcp-${crypto.randomUUID().substring(0, 8)}`,
      "Auto-created by MCP OAuth flow",
      userId,
      workspaceId,
    ],
  );

  return token;
}

/**
 * HTTP client for TaskPilot REST API.
 * Uses the user's API token from the shared database for authentication.
 */
export class TaskPilotClient {
  private baseUrl: string;
  private apiKey: string;
  private workspace: string;

  constructor(workspaceSlug: string, apiKey: string) {
    this.baseUrl = config.taskpilotApiUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.workspace = workspaceSlug;
  }

  /**
   * A cache discriminator that is stable for this user+workspace and safe to
   * put in a key. The projects endpoint is scoped to the calling user, so
   * caching its result per workspace alone would show one member's project
   * list to every other member of that workspace.
   */
  cacheScope(): string {
    return `${this.workspace}:${crypto.createHash("sha256").update(this.apiKey).digest("hex").slice(0, 16)}`;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`TaskPilot API error ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  // --- Projects ---
  async listProjects(): Promise<any[]> {
    const data = await this.request("GET", `/api/v1/workspaces/${this.workspace}/projects/`);
    return Array.isArray(data) ? data : data.results || data;
  }

  async getProject(projectId: string): Promise<any> {
    return this.request("GET", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/`);
  }

  // --- Issues ---
  async listIssues(projectId: string, params?: Record<string, string>): Promise<any> {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const data = await this.request("GET", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/issues/${qs}`);
    return Array.isArray(data) ? data : data.results || data;
  }

  async createIssue(projectId: string, data: any): Promise<any> {
    return this.request("POST", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/issues/`, data);
  }

  // --- Intake ---
  /** File into the project's intake queue. Wire shape: { issue: {...} }. */
  async createIntakeIssue(
    projectId: string,
    issue: { name: string; description_html?: string; priority?: string },
  ): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/intake-issues/`,
      { issue },
    );
  }

  async listIntakeIssues(projectId: string): Promise<any[]> {
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/intake-issues/`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }

  /** issueId is the underlying Issue's id, not the intake row's own id — the API keys the route that way. */
  async updateIntakeIssue(projectId: string, issueId: string, data: any): Promise<any> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/intake-issues/${issueId}/`,
      data,
    );
  }

  async getIssue(projectId: string, issueId: string): Promise<any> {
    return this.request("GET", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/issues/${issueId}/`);
  }

  async updateIssue(projectId: string, issueId: string, data: any): Promise<any> {
    return this.request("PATCH", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/issues/${issueId}/`, data);
  }

  async getIssueByIdentifier(identifier: string): Promise<any> {
    return this.request("GET", `/api/v1/workspaces/${this.workspace}/work-items/${identifier}/`);
  }

  // --- States ---
  async listStates(projectId?: string): Promise<any[]> {
    let data;
    if (projectId) {
      data = await this.request("GET", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/states/`);
    } else {
      data = await this.request("GET", `/api/v1/workspaces/${this.workspace}/states/`);
    }
    return Array.isArray(data) ? data : data.results || data;
  }

  // --- Cycles ---
  async listCycles(projectId: string): Promise<any[]> {
    const data = await this.request("GET", `/api/v1/workspaces/${this.workspace}/projects/${projectId}/cycles/`);
    return Array.isArray(data) ? data : data.results || data;
  }

  async addIssueToCycle(projectId: string, cycleId: string, issueIds: string[]): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`,
      { issues: issueIds },
    );
  }

  // --- Comments ---
  async addComment(projectId: string, issueId: string, comment: string): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/issues/${issueId}/comments/`,
      { comment_html: `<p>${comment}</p>` },
    );
  }

  // --- Members ---
  async listMembers(projectId?: string): Promise<any[]> {
    let data;
    if (projectId) {
      data = await this.request(
        "GET",
        `/api/v1/workspaces/${this.workspace}/projects/${projectId}/members/`,
      );
    } else {
      data = await this.request(
        "GET",
        `/api/v1/workspaces/${this.workspace}/members/`,
      );
    }
    return Array.isArray(data) ? data : data.results || data;
  }

  // --- Assignees ---
  async addAssignee(projectId: string, issueId: string, userId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentAssignees: string[] = issue.assignees || [];
    if (currentAssignees.includes(userId)) {
      return issue; // already assigned
    }
    return this.updateIssue(projectId, issueId, {
      assignees: [...currentAssignees, userId],
    });
  }

  async removeAssignee(projectId: string, issueId: string, userId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentAssignees: string[] = issue.assignees || [];
    return this.updateIssue(projectId, issueId, {
      assignees: currentAssignees.filter((id: string) => id !== userId),
    });
  }

  // --- Labels ---
  async listLabels(projectId: string): Promise<any[]> {
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/labels/`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }

  async addLabel(projectId: string, issueId: string, labelId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentLabels: string[] = issue.labels || [];
    if (currentLabels.includes(labelId)) {
      return issue;
    }
    return this.updateIssue(projectId, issueId, {
      labels: [...currentLabels, labelId],
    });
  }

  async removeLabel(projectId: string, issueId: string, labelId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentLabels: string[] = issue.labels || [];
    return this.updateIssue(projectId, issueId, {
      labels: currentLabels.filter((id: string) => id !== labelId),
    });
  }

  // --- Pages ---
  async listPages(projectId: string, params?: Record<string, string>): Promise<any[]> {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${qs}`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }

  async getPage(projectId: string, pageId: string): Promise<any> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/`,
    );
  }

  async createPage(projectId: string, data: Record<string, unknown>): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/`,
      data,
    );
  }

  /** Description lives behind its own endpoint, not the page PATCH. */
  async updatePageDescription(
    projectId: string,
    pageId: string,
    descriptionHtml: string,
  ): Promise<any> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/description/`,
      { description_html: descriptionHtml },
    );
  }

  async archivePage(projectId: string, pageId: string): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/archive/`,
    );
  }

  async listPageVersions(projectId: string, pageId: string): Promise<any[]> {
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/versions/`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }
}
