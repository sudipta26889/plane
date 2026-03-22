import crypto from "node:crypto";

export type CodeChallengeMethod = "S256" | "plain";

export function generateCodeVerifier(): string {
  const buffer = crypto.randomBytes(32);
  return base64UrlEncode(buffer);
}

export function createCodeChallenge(
  codeVerifier: string,
  method: CodeChallengeMethod = "S256",
): string {
  if (method === "plain") {
    return codeVerifier;
  }
  if (method === "S256") {
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    return base64UrlEncode(hash);
  }
  throw new Error(`Unsupported code challenge method: ${method}`);
}

export function verifyCodeChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method: CodeChallengeMethod = "S256",
): boolean {
  try {
    const computedChallenge = createCodeChallenge(codeVerifier, method);
    return timingSafeEqual(computedChallenge, codeChallenge);
  } catch {
    return false;
  }
}

export function validateCodeVerifier(codeVerifier: string): boolean {
  if (!codeVerifier) return false;
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  return /^[A-Za-z0-9\-._~]+$/.test(codeVerifier);
}

export function validateCodeChallengeMethod(
  method: string,
): method is CodeChallengeMethod {
  return method === "S256" || method === "plain";
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateSecureToken(bytes = 32): string {
  const buffer = crypto.randomBytes(bytes);
  return base64UrlEncode(buffer);
}
