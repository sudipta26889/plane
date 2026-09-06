import Redis from "ioredis";
import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: true });
    // ioredis emits 'error' on later connection drops, not just the initial
    // connect. An EventEmitter 'error' with no listener crashes the process —
    // which would turn a cache blip into an outage.
    redis.on("error", (err) => {
      console.warn("[smart-router] Redis error, running uncached:", err.message);
    });
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

/**
 * Deprecated: use routeWorkItem from ../routing/router.js, which returns a
 * confidence score instead of always producing a project id. Kept only so
 * existing callers keep compiling; it throws rather than guessing.
 */
export async function routeTask(): Promise<never> {
  throw new Error("routeTask has been replaced by routeWorkItem; update the caller");
}
