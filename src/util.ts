export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export const now = () => Date.now();

const encoder = new TextEncoder();

export function clamp(value: unknown, max: number): string {
  const s = value == null ? "" : String(value);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64(bytes: Uint8Array): string {
  // In chunks: photos are hundreds of KB, and one character at a time is slow.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export const randomToken = (bytes = 24) => b64url(randomBytes(bytes));

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))));
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

export const hmacHex = async (key: Uint8Array | string, data: string) => hex(await hmac(key, data));
export const hmacB64 = async (key: Uint8Array | string, data: string) => b64(await hmac(key, data));

/** Constant-time string compare, so secrets can't be guessed by timing. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

/** Reads a request body, refusing anything bigger than `max` bytes. */
export async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new HttpError(413, "Body too large");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) throw new HttpError(413, "Body too large");
  return new TextDecoder().decode(buf);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await readLimited(req, 128 * 1024);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, "Send a JSON object");
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

// Apps that ask for an "API key" send it in different ways: Bearer, a bare
// Authorization header, or X-API-Key. Accept all three for staff keys.
export function apiKey(req: Request): string | null {
  const auth = (req.headers.get("authorization") ?? "").trim();
  return bearer(req) ?? (auth.startsWith("rk_") ? auth : null) ?? (req.headers.get("x-api-key")?.trim() || null);
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Checks a doorbell (wake-up) link before we ever send anything to it. */
export function checkWakeUrl(value: string, allowLocal: boolean): string {
  return checkPublicUrl(value, allowLocal, "doorbell link");
}

/** Checks a link we are about to call or download from: https only, no private or local hosts. */
export function checkPublicUrl(value: string, allowLocal: boolean, what: string): string {
  const What = what[0].toUpperCase() + what.slice(1) + "s";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(400, `That ${what} is not a valid URL`);
  }
  if (u.protocol !== "https:" && !(allowLocal && u.protocol === "http:")) {
    throw new HttpError(400, `${What} must start with https://`);
  }
  if (u.username || u.password) throw new HttpError(400, `${What} cannot contain a username or password`);
  if (!allowLocal && isPrivateHost(u.hostname)) {
    throw new HttpError(400, `${What} cannot point to a private or local address`);
  }
  return u.toString();
}
