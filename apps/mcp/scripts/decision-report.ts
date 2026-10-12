/**
 * How well are the live decisions doing, and are their thresholds certified?
 *
 *   npx tsx --env-file=../../.env scripts/decision-report.ts report [days]
 *   npx tsx --env-file=../../.env scripts/decision-report.ts sample <feature> [n]
 *   npx tsx --env-file=../../.env scripts/decision-report.ts verdict <run-id> ok|wrong
 *
 * `sample` draws uniformly from ACCEPTED decisions not yet audited. Uniform
 * matters: labels gathered only from items that went to Intake describe the
 * hard cases, not the error rate of what was filed automatically.
 */
import { db } from "../src/db.js";
import { errorUpperBound } from "../src/decisions/certify.js";

const TARGET = 0.05;
const [command = "report", a, b] = process.argv.slice(2);

async function report(days: number) {
  const outcomes = await db.query(
    `SELECT feature, mode, outcome, count(*)::int AS n FROM decision_model_runs
     WHERE created_at > now() - make_interval(days => $1) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    [days],
  );
  console.log(`Decisions in the last ${days} days:`);
  for (const r of outcomes.rows) console.log(`  ${r.feature.padEnd(14)} ${r.mode.padEnd(7)} ${r.outcome.padEnd(14)} ${r.n}`);

  const models = await db.query(`SELECT model, min(created_at)::date AS since, count(*)::int AS n FROM decision_model_runs GROUP BY 1 ORDER BY 2`);
  console.log(`\nJev versions that answered (an upgrade can shift thresholds):`);
  for (const r of models.rows) console.log(`  ${r.model} since ${r.since}: ${r.n} runs`);

  const audits = await db.query(
    `SELECT feature, count(*)::int AS n, count(*) FILTER (WHERE audit_verdict = 'wrong')::int AS wrong
     FROM decision_model_runs WHERE audit_verdict IS NOT NULL GROUP BY 1`,
  );
  console.log(`\nAudited accepted decisions (target: error <= ${TARGET * 100}% at 95% confidence):`);
  if (audits.rows.length === 0) console.log("  none yet — run `sample <feature>` and record verdicts");
  for (const r of audits.rows) {
    const bound = errorUpperBound(r.wrong, r.n);
    console.log(`  ${r.feature.padEnd(14)} ${r.wrong}/${r.n} wrong, true error <= ${(bound * 100).toFixed(1)}% ${bound <= TARGET ? "CERTIFIED" : "not yet certified"}`);
  }
}

async function sample(feature: string, n: number) {
  const rows = await db.query(
    `SELECT id, created_at::date AS day, subject, jev_result, fallback_result FROM decision_model_runs
     WHERE feature = $1 AND audit_verdict IS NULL AND outcome IN ('decided', 'agree', 'disagree')
     ORDER BY random() LIMIT $2`,
    [feature, n],
  );
  for (const r of rows.rows) {
    const decided = r.jev_result ?? r.fallback_result;
    console.log(`#${r.id} ${r.day} "${r.subject}"\n    decided: ${JSON.stringify(decided)}`);
  }
  console.log(`\nRecord each with: verdict <id> ok|wrong`);
}

async function verdict(id: string, value: string) {
  if (!["ok", "wrong"].includes(value)) throw new Error("verdict must be ok or wrong");
  const r = await db.query(`UPDATE decision_model_runs SET audit_verdict = $2 WHERE id = $1`, [id, value]);
  console.log(r.rowCount ? `#${id} = ${value}` : `no run #${id}`);
}

if (command === "report") await report(parseInt(a || "30", 10));
else if (command === "sample") await sample(a!, parseInt(b || "10", 10));
else if (command === "verdict") await verdict(a!, b!);
else console.log("commands: report [days] | sample <feature> [n] | verdict <id> ok|wrong");
await db.end();
