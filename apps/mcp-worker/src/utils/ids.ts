const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes: BufferSource = typeof data === "string" ? enc.encode(data) : (data as BufferSource);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

/** Deterministic id so re-delivered queue messages / repeated crawls never duplicate rows. */
export async function stableId(prefix: string, ...parts: Array<string | number | null | undefined>): Promise<string> {
  const h = await sha256Hex(parts.map((p) => String(p ?? "")).join("␟"));
  return `${prefix}_${h.slice(0, 24)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
