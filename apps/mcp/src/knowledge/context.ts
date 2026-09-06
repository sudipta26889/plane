import Redis from "ioredis";
import { config } from "../config.js";
import type { TaskPilotClient } from "../tools/taskpilot-client.js";

export interface ProjectSummary {
  id: string;
  name: string;
  identifier: string;
  description: string;
}

export interface WorkspaceContext {
  projects: ProjectSummary[];
  rules: string;
}

const CACHE_TTL_SECONDS = 300;

/**
 * Facts about TaskPilot itself that models otherwise invent. Cycles and
 * modules are deliberately called out as unused: both tables are empty.
 */
export const TASKPILOT_RULES = `TaskPilot facts you must not contradict:
- TaskPilot is its own product. It is not Linear, Jira, Asana or any other tool.
- There is no delete for work items. To remove one, cancel it.
- Cancelling requires human approval and may not take effect immediately.
- Uncertain items belong in Intake, not in a guessed project.
- Cycles and modules exist in the schema but are unused here — do not route to them.`;

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: true });
    // ioredis emits 'error' on later connection drops, not just the initial
    // connect. An EventEmitter 'error' with no listener crashes the process —
    // which would turn a cache blip into an outage.
    redis.on("error", (err) => {
      console.warn("[context] Redis error, running uncached:", err.message);
    });
    redis.connect().catch((err) => {
      console.warn("[context] Redis unavailable, running uncached:", err.message);
      redis = null;
    });
  }
  return redis;
}

export function formatProjectsForPrompt(projects: ProjectSummary[]): string {
  return projects
    .map(
      (project) =>
        `- id: ${project.id}\n  identifier: ${project.identifier}\n  name: ${project.name}\n  description: ${
          project.description || "(no description)"
        }`,
    )
    .join("\n");
}

export async function getWorkspaceContext(
  workspace: string,
  client: TaskPilotClient,
): Promise<WorkspaceContext> {
  const cacheKey = `mcp:ctx:${workspace}`;

  try {
    const cached = await getRedis()?.get(cacheKey);
    if (cached) {
      return { projects: JSON.parse(cached), rules: TASKPILOT_RULES };
    }
  } catch {
    // Cache read failures are not routing failures.
  }

  const raw = await client.listProjects();
  const projects: ProjectSummary[] = (raw || []).map((project: any) => ({
    id: String(project.id),
    name: project.name || "",
    identifier: project.identifier || "",
    description: project.description || "",
  }));

  try {
    await getRedis()?.set(cacheKey, JSON.stringify(projects), "EX", CACHE_TTL_SECONDS);
  } catch {
    // ignore
  }

  return { projects, rules: TASKPILOT_RULES };
}
