import { timingSafeEqual, toHex } from "./ids";

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Short-lived signed download link for a stored PDF version. No bucket credentials are ever exposed. */
export async function signDownload(secret: string, versionId: string, ttlSeconds: number, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const sig = await hmac(secret, `${versionId}.${exp}`);
  return { exp, sig, path: `/download/${encodeURIComponent(versionId)}?exp=${exp}&sig=${sig}` };
}

export async function verifyDownload(secret: string, versionId: string, exp: string | null, sig: string | null, nowMs = Date.now()): Promise<boolean> {
  if (!secret || !exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(nowMs / 1000)) return false;
  return timingSafeEqual(await hmac(secret, `${versionId}.${exp}`), sig);
}
