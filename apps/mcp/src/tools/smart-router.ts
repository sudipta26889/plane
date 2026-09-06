import OpenAI from "openai";
import Redis from "ioredis";
import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { TaskPilotClient } from "./taskpilot-client.js";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: true });
    redis.connect().catch((err) => {
      console.warn("[smart-router] Redis connection failed, routing without cache:", err.message);
      redis = null;
    });
  }
  return redis!;
}

const ROUTING_SYSTEM_PROMPT = `You are a task router. Given projects and a task, return ONLY the matching project ID. Return the COMPLETE UUID including hyphens. Nothing else.`;

const CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

// --- LLM config from instance_configurations (same DB as Django) ---

interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

let cachedLlmConfig: LlmConfig | null = null;
let llmConfigFetchedAt = 0;
const LLM_CONFIG_TTL = 5 * 60 * 1000; // refresh every 5 minutes

/**
 * Decrypt a Fernet-encrypted value using the same key derivation as Django.
 * Derivation: PBKDF2-HMAC-SHA256(SECRET_KEY, salt="salt", iterations=100000)
 */
function decryptInstanceValue(encrypted: string): string {
  // Derive 32-byte key via PBKDF2 (same as Django's derive_key())
  const dk = crypto.pbkdf2Sync(config.jwtSecret, "salt", 100000, 32, "sha256");
  // Fernet splits the 32-byte key: first 16 = signing key, last 16 = encryption key
  const encryptionKey = dk.subarray(16, 32);

  // Fernet token format: Version(1) + Timestamp(8) + IV(16) + Ciphertext(N) + HMAC(32)
  const tokenBytes = Buffer.from(encrypted, "base64");
  const iv = tokenBytes.subarray(9, 25);
  const ciphertext = tokenBytes.subarray(25, tokenBytes.length - 32);

  const decipher = crypto.createDecipheriv("aes-128-cbc", encryptionKey, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export async function getLlmConfig(): Promise<LlmConfig> {
  const now = Date.now();
  if (cachedLlmConfig && now - llmConfigFetchedAt < LLM_CONFIG_TTL) {
    return cachedLlmConfig;
  }

  const result = await db.query(
    `SELECT key, value, is_encrypted FROM instance_configurations WHERE key IN ('LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL')`,
  );

  let apiKey = "";
  let baseUrl = config.llmApiBaseUrl;
  let model = config.llmModel;

  for (const row of result.rows) {
    let val = row.value || "";
    if (row.is_encrypted && val) {
      try {
        val = decryptInstanceValue(val);
      } catch (err: any) {
        console.warn(`[smart-router] Failed to decrypt ${row.key}:`, err.message);
        continue;
      }
    }
    if (row.key === "LLM_API_KEY") apiKey = val;
    if (row.key === "LLM_API_BASE_URL") baseUrl = val || baseUrl;
    if (row.key === "LLM_MODEL") model = val || model;
  }

  cachedLlmConfig = { apiKey, baseUrl, model };
  llmConfigFetchedAt = now;
  console.log(`[smart-router] LLM config loaded: baseUrl=${baseUrl}, model=${model}, key=${apiKey ? "set" : "missing"}`);
  return cachedLlmConfig;
}

// --- Routing ---

async function getCachedProject(workspace: string, title: string): Promise<string | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const key = `mcp:route:${workspace}:${title.toLowerCase().trim()}`;
    return await r.get(key);
  } catch {
    return null;
  }
}

async function setCachedProject(workspace: string, title: string, projectId: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const key = `mcp:route:${workspace}:${title.toLowerCase().trim()}`;
    await r.set(key, projectId, "EX", CACHE_TTL);
  } catch {
    // ignore cache errors
  }
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "has", "are", "was",
  "were", "been", "will", "can", "may", "not", "but", "all", "any", "each", "our",
  "his", "her", "its", "who", "how", "what", "when", "where", "which", "their",
  "them", "they", "your", "you", "she", "him", "get", "got", "set", "put", "new",
  "old", "use", "one", "two", "next", "last", "before", "after",
]);

export async function routeTask(
  workspace: string,
  title: string,
  projectHint?: string,
  client?: TaskPilotClient,
): Promise<string> {
  if (!client) {
    throw new Error("TaskPilotClient is required for routing");
  }

  const projects = await client.listProjects();
  if (!projects || projects.length === 0) {
    throw new Error("No projects found in workspace");
  }

  // If hint provided, try match first
  if (projectHint) {
    const match = projects.find(
      (p: any) =>
        projectHint.toLowerCase().includes(p.name?.toLowerCase()) ||
        p.name?.toLowerCase().includes(projectHint.toLowerCase()) ||
        projectHint.toLowerCase() === p.identifier?.toLowerCase(),
    );
    if (match) return String(match.id);
  }

  // Single project — no routing needed
  if (projects.length === 1) {
    return String(projects[0].id);
  }

  // Check cache
  const cached = await getCachedProject(workspace, title);
  if (cached) {
    console.log(`[smart-router] Cache hit for "${title}" -> ${cached}`);
    return cached;
  }

  // Try LLM first (semantic understanding) — fall back to keywords
  const projectList = projects.map((p: any) => ({
    id: String(p.id),
    name: p.name || "",
    description: p.description || "",
  }));

  try {
    const llmConfig = await getLlmConfig();
    if (!llmConfig.apiKey) throw new Error("No LLM API key configured");

    const llm = new OpenAI({
      baseURL: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
    });

    const response = await llm.chat.completions.create({
      model: llmConfig.model || "ollama/gpt-oss:120b-cloud",
      messages: [
        { role: "system", content: ROUTING_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Projects:\n${JSON.stringify(projectList, null, 2)}\n\nTask: ${title}`,
        },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    let projectId = response.choices[0]?.message?.content?.trim().replace(/"/g, "") || "";

    // Extract UUID from response (model may wrap it in text)
    const uuidMatch = projectId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) projectId = uuidMatch[0];

    // Validate
    const validIds = new Set(projects.map((p: any) => String(p.id)));
    if (!validIds.has(projectId)) {
      console.warn(`[smart-router] LLM returned invalid ID "${projectId}", falling back to keywords`);
      throw new Error("LLM returned invalid project ID");
    }

    await setCachedProject(workspace, title, projectId);
    const matchedName = projects.find((p: any) => String(p.id) === projectId)?.name;
    console.log(`[smart-router] Routed "${title}" -> ${matchedName} (LLM)`);
    return projectId;
  } catch (err: any) {
    console.warn(`[smart-router] LLM unavailable: ${err.message}, trying keyword match`);
  }

  // Keyword scoring fallback — match task title words against project name + description
  const titleLower = title.toLowerCase();
  const titleWords = titleLower.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  let bestScore = 0;
  let bestProject: string | null = null;

  for (const p of projects) {
    const corpus = `${p.name || ""} ${p.description || ""}`.toLowerCase();
    let score = 0;
    for (const word of titleWords) {
      if (corpus.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestProject = String(p.id);
    }
  }

  if (bestProject && bestScore >= 1) {
    const matchedName = projects.find((p: any) => String(p.id) === bestProject)?.name;
    console.log(`[smart-router] Keyword match: "${title}" -> ${matchedName} (score: ${bestScore})`);
    await setCachedProject(workspace, title, bestProject);
    return bestProject;
  }

  // Last resort: first project
  console.warn(`[smart-router] No match for "${title}", using first project`);
  return String(projects[0].id);
}
