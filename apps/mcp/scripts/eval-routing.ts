/**
 * Replay existing work items through the router and report accuracy.
 *
 * Every work item's current project is ground truth, so this measures the
 * router against reality rather than against our expectations. Ground truth
 * is human filing, not gospel — some items were misfiled by people, so a
 * "misroute" here can mean the router disagreed with a shaky call, not that
 * the router was necessarily wrong. Report the disagreement rate faithfully
 * either way.
 *
 * Run from the host (not inside a container), pointed at the repo .env:
 *
 *   cd apps/mcp
 *   TASKPILOT_API_URL=http://localhost:4647 npx tsx --env-file=../../.env scripts/eval-routing.ts <workspace-slug> [sample-size]
 *
 * TASKPILOT_API_URL must be overridden to localhost — the .env default
 * (http://api:4647) is the docker-internal hostname for the API container
 * and does not resolve from the host, which otherwise fails as an opaque
 * "fetch failed".
 *
 * Usage: npx tsx scripts/eval-routing.ts <workspace-slug> [sample-size]
 */
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { routeWorkItem } from "../src/routing/router.js";
import { TaskPilotClient, getOrCreateApiToken } from "../src/tools/taskpilot-client.js";

const workspace = process.argv[2];
const sampleSize = parseInt(process.argv[3] || "100", 10);

if (!workspace) {
  console.error("Usage: npx tsx scripts/eval-routing.ts <workspace-slug> [sample-size]");
  process.exit(1);
}

async function main() {
  const ws = await db.query(`SELECT id FROM workspaces WHERE slug = $1`, [workspace]);
  if (ws.rows.length === 0) throw new Error(`No such workspace: ${workspace}`);

  // workspace_members' member column is `member_id`, not `user_id`, and rows
  // are soft-deleted via `deleted_at` rather than removed.
  const owner = await db.query(
    `SELECT member_id FROM workspace_members WHERE workspace_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [ws.rows[0].id],
  );
  if (owner.rows.length === 0) throw new Error(`No members in workspace: ${workspace}`);

  const token = await getOrCreateApiToken(owner.rows[0].member_id, workspace);
  const client = new TaskPilotClient(workspace, token);

  const items = await db.query(
    `SELECT i.name, i.description_stripped, i.project_id, p.identifier
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     WHERE i.deleted_at IS NULL AND i.workspace_id = $1
     ORDER BY random()
     LIMIT $2`,
    [ws.rows[0].id, sampleSize],
  );

  let correct = 0;
  let wrong = 0;
  let undecided = 0;
  const misroutes: string[] = [];

  for (const item of items.rows) {
    const decision = await routeWorkItem(
      {
        workspace,
        title: item.name,
        description: item.description_stripped || undefined,
      },
      client,
    );

    if (!decision.projectId) {
      undecided++;
    } else if (decision.projectId === String(item.project_id)) {
      correct++;
    } else {
      wrong++;
      const gotProject = decision.candidates.find((p) => p.id === decision.projectId);
      const gotLabel = gotProject ? gotProject.identifier : decision.projectId;
      misroutes.push(
        `  "${item.name.slice(0, 60)}" → expected ${item.identifier}, got ${gotLabel} (conf ${decision.confidence.toFixed(2)}): ${decision.reason}`,
      );
    }
  }

  const total = items.rows.length;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  console.log(`\nRouting eval — ${workspace}, ${total} items, threshold ${config.routeConfidenceThreshold}`);
  console.log(`  correct:   ${correct} (${pct(correct)})`);
  console.log(`  MISROUTED: ${wrong} (${pct(wrong)})   <- the number that must approach zero`);
  console.log(`  undecided: ${undecided} (${pct(undecided)})   <- safe: these go to Intake, never counted as accuracy`);

  if (misroutes.length > 0) {
    console.log(`\nMisroutes (title → expected vs. chosen project, confidence, router's reason):\n${misroutes.join("\n")}`);
  }

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
