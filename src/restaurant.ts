import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { handleHook } from "./hooks";
import { NotionBudgetSpent, NotionClient, NotionRateLimited } from "./notion";
import {
  HttpError,
  apiKey,
  b64,
  checkPublicUrl,
  checkWakeUrl,
  clamp,
  hmacB64,
  json,
  now,
  randomBytes,
  randomToken,
  readJson,
  safeEqual,
  sha256Hex,
} from "./util";

export interface Staff {
  id: number;
  name: string;
  vendor: string;
  role: "chief" | "helper";
  token_hash: string;
  wake_url: string | null;
  wake_secret: string | null;
  /** Sent as the Authorization header when ringing (e.g. Cursor Automations needs "Bearer …"). */
  wake_auth: string | null;
  quota: number | null;
  quota_note: string | null;
  quota_at: number | null;
  last_seen: number | null;
  inbox_at: number | null;
  active: number;
  created_at: number;
}

export interface Task {
  id: number;
  title: string;
  detail: string;
  status: Status;
  assignee_id: number | null;
  created_by: string;
  due: string | null;
  tokens_used: number;
  created_at: number;
  updated_at: number;
}

export interface Source {
  id: string;
  name: string;
  kind: "github" | "notion" | "generic";
  secret: string;
  notion_token: string | null;
  route_staff_id: number | null;
  created_at: number;
  last_event_at: number | null;
}

export type Actor = { kind: "owner" } | { kind: "staff"; staff: Staff };
type Args = Record<string, unknown>;

const STATUSES = ["todo", "doing", "review", "done"] as const;
type Status = (typeof STATUSES)[number];
const ROLES = ["chief", "helper"];
const RETRY_SECONDS = [5, 20, 80];
const SESSION_MS = 30 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const LOGIN_FAILS_PER_15_MIN = 5;
const LOGIN_FAILS_PER_DAY = 20;
// Daily backup check: local wall-clock time in a time zone, so it follows summer time.
// Set with DAILY_CHECK_TIME and DAILY_CHECK_TZ in wrangler.jsonc.
type DailySchedule = { h: number; m: number; tz: string; label: string };

function dailySchedule(env: Env): DailySchedule {
  const [, h, m] = /^(\d{1,2}):(\d{2})$/.exec(env.DAILY_CHECK_TIME ?? "") ?? [, "6", "00"];
  let tz = env.DAILY_CHECK_TZ || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const hh = Math.min(Number(h), 23), mm = Math.min(Number(m), 59);
  return { h: hh, m: mm, tz, label: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${tz}` };
}

// How far the time zone's clock is ahead of UTC at moment t.
function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(t)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

function nextDailyCheck(s: DailySchedule, t = now()): number {
  const wall = new Date(t + tzOffset(t, s.tz));
  wall.setUTCHours(s.h, s.m, 0, 0);
  for (;;) {
    const at = wall.getTime() - tzOffset(wall.getTime() - tzOffset(t, s.tz), s.tz);
    if (at > t) return at;
    wall.setUTCDate(wall.getUTCDate() + 1);
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    vendor TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'helper',
    token_hash TEXT NOT NULL,
    wake_url TEXT, wake_secret TEXT,
    quota INTEGER, quota_note TEXT, quota_at INTEGER,
    last_seen INTEGER, inbox_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    assignee_id INTEGER, created_by TEXT NOT NULL, due TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER, author TEXT NOT NULL, author_staff_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT, source_name TEXT NOT NULL, kind TEXT NOT NULL,
    summary TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
    staff_id INTEGER, read_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    secret TEXT NOT NULL, notion_token TEXT, route_staff_id INTEGER,
    created_at INTEGER NOT NULL, last_event_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE COLLATE NOCASE, body TEXT NOT NULL,
    updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL, task_id INTEGER,
    action TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', note TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL, reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
    created_at INTEGER NOT NULL, sent_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS login_failures (at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
    name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
    added_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

// Photos on orders. The dashboard shrinks them before upload, so these limits are rarely reached.
// A Durable Object SQLite row holds at most 2 MB, so one photo must stay under that.
const PHOTO_MAX_BYTES = 1_900_000;
const PHOTO_TOO_BIG = "Photo is too big (max 1.9 MB). Save it as JPEG or make it smaller.";
const PHOTOS_PER_ORDER = 10;
// Photos posted in the team chat are stored with task_id 0 (order numbers start at 1).
const CHAT_PHOTO = 0;
// Body of a chat message that is only a photo, with no words.
const PHOTO_ONLY = "📷 Photo";
const PHOTO_STORAGE_CAP = 1_000_000_000; // stay well inside the free Durable Object storage
const PHOTO_SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
};

export interface AttachmentInfo {
  id: number;
  task_id: number;
  name: string;
  mime: string;
  size: number;
  added_by: string;
  created_at: number;
}

// Columns added after v1. SQLite has no "ADD COLUMN IF NOT EXISTS", so failures (already added) are ignored.
const ADDED_COLUMNS = [
  `ALTER TABLE recipes ADD COLUMN origin TEXT NOT NULL DEFAULT 'restaurant'`,
  `ALTER TABLE recipes ADD COLUMN notion_page_id TEXT`,
  `ALTER TABLE recipes ADD COLUMN notion_url TEXT`,
  `ALTER TABLE recipes ADD COLUMN notion_edited TEXT`,
  `ALTER TABLE staff ADD COLUMN wake_auth TEXT`,
  `ALTER TABLE messages ADD COLUMN photo_id INTEGER`,
];

const NOTION_DAILY = 24 * 3600 * 1000;
// Big enough for a full working skill (instructions plus its reference notes).
const RECIPE_MAX = 60_000;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function int(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${what} must be a whole number`);
  return n;
}

function actorName(a: Actor): string {
  return a.kind === "owner" ? "Owner" : a.staff.name;
}

function isBoss(a: Actor): boolean {
  return a.kind === "owner" || a.staff.role === "chief";
}

function publicStaff(s: Staff) {
  const { token_hash, wake_secret, wake_auth, ...rest } = s;
  return { ...rest, has_wake_secret: !!wake_secret, has_wake_auth: !!wake_auth };
}

export class Restaurant extends DurableObject<Env> {
  private sql: SqlStorage;
  private notionSync: Promise<unknown> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of SCHEMA) this.sql.exec(q);
    for (const q of ADDED_COLUMNS) {
      try {
        this.sql.exec(q);
      } catch {}
    }
    ctx.blockConcurrencyWhile(async () => {
      // Reschedule on first start, or when the daily check time was changed in the config.
      const daily = dailySchedule(env);
      if (!this.getMeta("daily_check_due") || this.getMeta("daily_check_at") !== daily.label) {
        this.setMeta("daily_check_at", daily.label);
        this.setMeta("daily_check_due", nextDailyCheck(daily));
        await this.scheduleAlarm();
      }
    });
  }

  private getMeta(key: string): string | null {
    return this.one<{ value: string | null }>("SELECT value FROM meta WHERE key=?", key)?.value ?? null;
  }

  private setMeta(key: string, value: string | number | null) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value == null ? null : String(value));
  }

  all<T>(q: string, ...args: unknown[]): T[] {
    const bound = args.map((v) => (v === undefined ? null : v)) as SqlStorageValue[];
    return this.sql.exec(q, ...bound).toArray() as unknown as T[];
  }

  one<T>(q: string, ...args: unknown[]): T | undefined {
    return this.all<T>(q, ...args)[0];
  }

  get restaurantName(): string {
    return this.env.RESTAURANT_NAME || "AI Agent Restaurant";
  }

  // ---------- HTTP entry ----------

  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "hook") return await handleHook(this, req, parts[1] ?? "");
      if (parts[0] === "mcp") {
        const key = parts[1] ?? apiKey(req);
        const staff = key ? await this.staffByKey(key) : undefined;
        if (!staff) {
          console.log("mcp 401", parts[1] ? "key in path" : key ? "key in header" : "no key", [...req.headers.keys()].join(","), req.headers.get("user-agent") ?? "");
          return json({ error: "Unknown or missing staff key" }, 401);
        }
        this.sql.exec("UPDATE staff SET last_seen=? WHERE id=?", now(), staff.id);
        // Staff with a shell can send a photo file straight in: POST /mcp/<key>/photos/<order id>
        if (parts[2] === "photos" && req.method === "POST") {
          if (Number(req.headers.get("content-length") ?? 0) > PHOTO_MAX_BYTES) throw new HttpError(413, PHOTO_TOO_BIG);
          const bytes = new Uint8Array(await req.arrayBuffer());
          const name = clamp(url.searchParams.get("name") || "photo", 80);
          return json(await this.addAttachment({ kind: "staff", staff }, int(parts[3], "order id"), name, photoMime(bytes), bytes));
        }
        return await handleMcp(this, req, staff);
      }
      if (parts[0] === "api") return await this.api(req, url, parts.slice(1));
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong in the kitchen" }, 500);
    }
  }

  // ---------- Owner dashboard API ----------

  private async api(req: Request, url: URL, parts: string[]): Promise<Response> {
    const m = req.method;
    if (parts[0] === "login" && m === "POST") return this.login(req);
    if (parts[0] === "logout" && m === "POST") {
      const token = sessionCookie(req);
      if (token) this.sql.exec("DELETE FROM sessions WHERE token_hash=?", await sha256Hex(token));
      return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
    }
    if (!(await this.hasSession(req))) throw new HttpError(401, "Please sign in");
    if (m !== "GET") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site request blocked");
    }
    const owner: Actor = { kind: "owner" };
    const [res, rawId, sub] = parts;
    const id = rawId ?? "";

    // Photos: raw image bytes in, raw image bytes out (not JSON).
    if (res === "tasks" && sub === "attachments" && m === "POST") {
      const name = clamp(url.searchParams.get("name") || "photo", 80);
      const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim();
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > PHOTO_MAX_BYTES) throw new HttpError(413, PHOTO_TOO_BIG);
      return json(await this.addAttachment(owner, int(id, "id"), name, mime, new Uint8Array(await req.arrayBuffer())));
    }
    if (res === "chat" && rawId === "photos" && m === "POST") {
      const name = clamp(url.searchParams.get("name") || "photo", 80);
      const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim();
      if (Number(req.headers.get("content-length") ?? 0) > PHOTO_MAX_BYTES) throw new HttpError(413, PHOTO_TOO_BIG);
      return json(this.storePhoto(owner, CHAT_PHOTO, name, mime, new Uint8Array(await req.arrayBuffer())));
    }
    if (res === "attachments" && m === "GET" && rawId) {
      const a = this.getAttachment(int(id, "id"));
      return new Response(a.data, {
        headers: {
          "content-type": a.mime,
          "content-disposition": "inline",
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const body = m === "POST" || m === "PATCH" || m === "PUT" ? await readJson(req) : {};

    switch (`${m} ${res ?? ""}${rawId ? "/:id" : ""}${sub ? "/" + sub : ""}`) {
      case "GET state":
        return json(this.state());
      case "POST staff":
        return json(await this.hire(body));
      case "PATCH staff/:id":
        return json(this.updateStaff(int(id, "id"), body));
      case "POST staff/:id/key":
        return json(await this.newKey(int(id, "id")));
      case "POST staff/:id/ring":
        return json(await this.ring(int(id, "id"), "Test ring from the owner", true));
      case "POST daily-check":
        return json(await this.dailyCheck());
      case "DELETE staff/:id":
        return json(this.letGo(int(id, "id")));
      case "POST tasks":
        return json(await this.createTask(owner, body));
      case "PATCH tasks/:id":
        return json(await this.updateTask(owner, int(id, "id"), body));
      case "POST messages":
        return json(await this.postMessage(owner, body.body, body.task_id, body.photo_id));
      case "POST events/read":
        this.sql.exec("UPDATE events SET read_at=? WHERE read_at IS NULL", now());
        return json({ ok: true });
      case "POST sources":
        return json(this.addSource(body));
      case "PATCH sources/:id":
        return json(this.updateSource(id, body));
      case "DELETE sources/:id":
        this.sql.exec("DELETE FROM sources WHERE id=?", id);
        return json({ ok: true });
      case "POST recipes":
        return json(this.saveRecipe(owner, body));
      case "DELETE recipes/:id": {
        const r = this.one<{ origin: string }>("SELECT origin FROM recipes WHERE id=?", int(id, "id"));
        if (r?.origin === "notion") throw new HttpError(409, "This recipe comes from Notion. Untick 'Published' or delete it in Notion instead.");
        this.sql.exec("DELETE FROM recipes WHERE id=?", int(id, "id"));
        return json({ ok: true });
      }
      case "POST notion/:id":
        if (id === "sync") return json(await this.syncNotion());
        break;
      case "DELETE attachments/:id":
        this.sql.exec("DELETE FROM attachments WHERE id=?", int(id, "id"));
        return json({ ok: true });
      case "POST approvals/:id/decide":
        return json(await this.decideApproval(int(id, "id"), body));
    }
    throw new HttpError(404, "Unknown API route");
  }

  private async login(req: Request): Promise<Response> {
    const password = this.env.OWNER_PASSWORD;
    if (!password) throw new HttpError(503, "OWNER_PASSWORD is not set. Run: npx wrangler secret put OWNER_PASSWORD");
    const t = now();
    // Wrong tries are saved, so the limits hold even after the restaurant restarts.
    // Signed-in devices keep working while locked, so a guesser can't lock the owner out of an open dashboard.
    const fails = (ms: number) => this.one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE at>?", t - ms)?.n ?? 0;
    if (fails(DAY) >= LOGIN_FAILS_PER_DAY) throw new HttpError(429, "Too many wrong passwords today. Sign-in is paused for up to 24 hours.");
    if (fails(15 * 60 * 1000) >= LOGIN_FAILS_PER_15_MIN) throw new HttpError(429, "Too many wrong passwords. Wait 15 minutes.");
    const body = await readJson(req);
    if (typeof body.password !== "string" || !safeEqual(body.password, password)) {
      this.sql.exec("INSERT INTO login_failures (at) VALUES (?)", t);
      throw new HttpError(401, "Wrong password");
    }
    const token = randomToken(32);
    this.sql.exec("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)", await sha256Hex(token), t + SESSION_MS);
    return json({ ok: true }, 200, { "set-cookie": cookie(token, SESSION_MS / 1000) });
  }

  private async hasSession(req: Request): Promise<boolean> {
    const token = sessionCookie(req);
    if (!token) return false;
    return !!this.one("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?", await sha256Hex(token), now());
  }

  state() {
    return {
      name: this.restaurantName,
      staff: this.all<Staff>("SELECT * FROM staff WHERE active=1 ORDER BY role='chief' DESC, name").map(publicStaff),
      tasks: this.all<Task>("SELECT * FROM tasks WHERE status!='done' OR updated_at>? ORDER BY id DESC", now() - 14 * DAY),
      messages: this.all("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 300) ORDER BY id"),
      events: this.all("SELECT * FROM events ORDER BY id DESC LIMIT 100"),
      sources: this.all<Source>("SELECT * FROM sources ORDER BY created_at"),
      recipes: this.all("SELECT * FROM recipes ORDER BY title"),
      approvals: this.all("SELECT * FROM approvals WHERE status='pending' OR created_at>? ORDER BY id DESC", now() - 7 * DAY),
      doorbell: this.all("SELECT * FROM outbox ORDER BY id DESC LIMIT 30"),
      attachments: this.all<AttachmentInfo>(
        "SELECT a.id, a.task_id, a.name, a.mime, a.size, a.added_by, a.created_at FROM attachments a JOIN tasks t ON t.id=a.task_id WHERE t.status!='done' OR t.updated_at>? ORDER BY a.id",
        now() - 14 * DAY,
      ),
      notion: {
        configured: this.notionConfigured,
        last_sync_at: Number(this.getMeta("notion_last_sync")) || null,
        last_result: this.getMeta("notion_last_result"),
        last_error: this.getMeta("notion_last_error"),
      },
      wrong_passwords_24h: this.one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE at>?", now() - DAY)?.n ?? 0,
      daily_check: {
        at: dailySchedule(this.env).label,
        next_at: Number(this.getMeta("daily_check_due")) || null,
        last: JSON.parse(this.getMeta("daily_check_last") ?? "null"),
      },
    };
  }

  // ---------- Notion skills sync (one way: Notion → recipe book) ----------

  get notionConfigured(): boolean {
    return !!(this.env.NOTION_TOKEN && this.env.NOTION_SKILLS_DB);
  }

  /** Asks for a sync soon. Many requests in a short time collapse into one run. */
  async requestNotionSync(delayMs: number) {
    if (!this.notionConfigured) return;
    const due = Number(this.getMeta("notion_due")) || Infinity;
    this.setMeta("notion_due", Math.min(due, now() + delayMs));
    await this.scheduleAlarm();
  }

  async syncNotion() {
    if (!this.notionConfigured) {
      throw new HttpError(400, "Notion is not connected yet. Set NOTION_TOKEN and NOTION_SKILLS_DB (see README).");
    }
    // Only one sync at a time; a second caller waits for the running one.
    this.notionSync ??= this.runNotionSync().finally(() => (this.notionSync = null));
    return this.notionSync;
  }

  private async runNotionSync() {
    const client = new NotionClient(this.env.NOTION_TOKEN!, this.env.NOTION_API_BASE || undefined);
    const result = { added: 0, updated: 0, removed: 0, unchanged: 0, more_coming: false };
    let nextDue = now() + NOTION_DAILY; // daily backup, in case a Notion notification was missed
    try {
      const skills = await client.listSkills(this.env.NOTION_SKILLS_DB!);
      const existing = new Map(
        this.all<{ id: number; notion_page_id: string; notion_edited: string | null; title: string }>(
          "SELECT id, notion_page_id, notion_edited, title FROM recipes WHERE origin='notion'",
        ).map((r) => [r.notion_page_id, r]),
      );
      for (const skill of skills) {
        const old = existing.get(skill.pageId);
        if (old && old.notion_edited === skill.edited) {
          result.unchanged++;
          continue;
        }
        let body: string;
        try {
          body = await client.pageMarkdown(skill.pageId);
        } catch (e) {
          if (e instanceof NotionBudgetSpent) {
            // Out of requests for this run: finish the rest shortly.
            result.more_coming = true;
            nextDue = now() + 15_000;
            break;
          }
          throw e;
        }
        // A dashboard recipe with the same title keeps its name; the Notion copy gets a suffix.
        const clash = this.one("SELECT 1 FROM recipes WHERE title=? AND (notion_page_id IS NULL OR notion_page_id!=?)", skill.title, skill.pageId);
        const title = clamp(clash ? `${skill.title} (Notion)` : skill.title, 120);
        const fields = [title, clamp(body, RECIPE_MAX), skill.url, skill.edited, now()] as const;
        if (old) {
          this.sql.exec("UPDATE recipes SET title=?, body=?, notion_url=?, notion_edited=?, updated_at=?, updated_by='Notion' WHERE id=?", ...fields, old.id);
          result.updated++;
        } else {
          this.sql.exec(
            "INSERT INTO recipes (title, body, notion_url, notion_edited, updated_at, updated_by, origin, notion_page_id) VALUES (?,?,?,?,?,'Notion','notion',?)",
            ...fields,
            skill.pageId,
          );
          result.added++;
        }
      }
      // Skills deleted or unpublished in Notion leave the recipe book too.
      const keep = new Set(skills.map((s) => s.pageId));
      for (const [pageId, r] of existing) {
        if (!keep.has(pageId)) {
          this.sql.exec("DELETE FROM recipes WHERE id=?", r.id);
          result.removed++;
        }
      }
      this.setMeta("notion_last_result", JSON.stringify(result));
      this.setMeta("notion_last_error", null);
    } catch (e) {
      if (e instanceof NotionRateLimited) nextDue = now() + e.retryAfterSeconds * 1000;
      else nextDue = now() + 3600 * 1000;
      this.setMeta("notion_last_error", clamp(e instanceof Error ? e.message : String(e), 300));
      if (!(e instanceof Error)) console.error(e);
    }
    this.setMeta("notion_last_sync", now());
    this.setMeta("notion_due", nextDue);
    await this.scheduleAlarm();
    const error = this.getMeta("notion_last_error");
    if (error) throw new HttpError(502, error);
    return result;
  }

  // ---------- Staff ----------

  async staffByKey(key: string): Promise<Staff | undefined> {
    return this.one<Staff>("SELECT * FROM staff WHERE token_hash=? AND active=1", await sha256Hex(key));
  }

  staffList() {
    return this.all<Staff>("SELECT * FROM staff WHERE active=1 ORDER BY role='chief' DESC, name").map((s) => ({
      name: s.name,
      vendor: s.vendor,
      role: s.role,
      quota_percent_left: s.quota,
      quota_note: s.quota_note,
      quota_reported_at: s.quota_at ? new Date(s.quota_at).toISOString() : null,
      last_seen: s.last_seen ? new Date(s.last_seen).toISOString() : null,
      open_orders: this.one<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status IN ('todo','doing')", s.id)?.n ?? 0,
    }));
  }

  private findStaff(ref: unknown): Staff {
    const r = str(ref).trim().replace(/^@/, "");
    const s = /^\d+$/.test(r)
      ? this.one<Staff>("SELECT * FROM staff WHERE id=? AND active=1", Number(r))
      : this.one<Staff>("SELECT * FROM staff WHERE name=? AND active=1", r);
    if (!s) throw new HttpError(400, `No staff member called "${r}"`);
    return s;
  }

  private chief(): Staff | undefined {
    return this.one<Staff>("SELECT * FROM staff WHERE role='chief' AND active=1");
  }

  private checkName(raw: unknown): string {
    const name = str(raw).trim();
    if (!/^[\p{L}\p{N} _.-]{1,32}$/u.test(name)) throw new HttpError(400, "Names can use letters, numbers, spaces, - _ . (up to 32)");
    return name;
  }

  private async hire(a: Args) {
    const name = this.checkName(a.name);
    const role = str(a.role || "helper");
    if (!ROLES.includes(role)) throw new HttpError(400, "Role must be chief or helper");
    const vendor = clamp(str(a.vendor).trim(), 40);
    const key = "rk_" + randomToken(24);
    const hash = await sha256Hex(key);
    const t = now();
    const existing = this.one<Staff>("SELECT * FROM staff WHERE name=?", name);
    if (existing?.active) throw new HttpError(409, `${name} already works here`);
    if (role === "chief") this.sql.exec("UPDATE staff SET role='helper' WHERE role='chief'");
    if (existing) {
      this.sql.exec("UPDATE staff SET active=1, role=?, vendor=?, token_hash=?, created_at=? WHERE id=?", role, vendor, hash, t, existing.id);
    } else {
      this.sql.exec("INSERT INTO staff (name, vendor, role, token_hash, created_at) VALUES (?,?,?,?,?)", name, vendor, role, hash, t);
    }
    const staff = this.findStaff(name);
    this.addMessage({ kind: "owner" }, `${name} joined the team as ${role}`, null, true);
    return { staff: publicStaff(staff), key };
  }

  private updateStaff(id: number, a: Args) {
    const s = this.findStaff(id);
    if (a.name !== undefined) {
      const name = this.checkName(a.name);
      if (name !== s.name) {
        const other = this.one<Staff>("SELECT * FROM staff WHERE name=? AND id!=?", name, id);
        if (other?.active) throw new HttpError(409, `${name} already works here`);
        // A former staff member with that name gives it up, so the name can be reused.
        if (other) this.sql.exec("UPDATE staff SET name=? WHERE id=?", `${other.name} (left ${other.id})`, other.id);
        this.sql.exec("UPDATE staff SET name=? WHERE id=?", name, id);
        this.addMessage({ kind: "owner" }, `${s.name} is now called ${name}`, null, true);
      }
    }
    if (a.role !== undefined) {
      const role = str(a.role);
      if (!ROLES.includes(role)) throw new HttpError(400, "Role must be chief or helper");
      if (role === "chief") this.sql.exec("UPDATE staff SET role='helper' WHERE role='chief'");
      this.sql.exec("UPDATE staff SET role=? WHERE id=?", role, id);
    }
    if (a.vendor !== undefined) this.sql.exec("UPDATE staff SET vendor=? WHERE id=?", clamp(str(a.vendor).trim(), 40), id);
    if (a.wake_url !== undefined) {
      const raw = str(a.wake_url).trim();
      const url = raw ? checkWakeUrl(raw, this.env.ALLOW_LOCAL_WAKE === "true") : null;
      this.sql.exec("UPDATE staff SET wake_url=? WHERE id=?", url, id);
    }
    if (a.wake_secret !== undefined) {
      this.sql.exec("UPDATE staff SET wake_secret=? WHERE id=?", str(a.wake_secret).trim() || null, id);
    }
    if (a.wake_auth !== undefined) {
      // Pasted values often carry a stray line break, which breaks the header; remove all of them.
      const auth = str(a.wake_auth).replace(/[\r\n]+/g, "").trim().replace(/^authorization:\s*/i, "");
      this.sql.exec("UPDATE staff SET wake_auth=? WHERE id=?", clamp(auth, 2000) || null, id);
    }
    return publicStaff(this.findStaff(s.id));
  }

  private async newKey(id: number) {
    const s = this.findStaff(id);
    const key = "rk_" + randomToken(24);
    this.sql.exec("UPDATE staff SET token_hash=? WHERE id=?", await sha256Hex(key), s.id);
    return { staff: publicStaff(s), key };
  }

  private letGo(id: number) {
    const s = this.findStaff(id);
    this.sql.exec("UPDATE staff SET active=0, role='helper' WHERE id=?", s.id);
    this.sql.exec(
      "UPDATE tasks SET assignee_id=NULL, status=CASE WHEN status='doing' THEN 'todo' ELSE status END, updated_at=? WHERE assignee_id=? AND status!='done'",
      now(),
      s.id,
    );
    this.sql.exec("UPDATE outbox SET status='failed', last_error='staff left' WHERE staff_id=? AND status='pending'", s.id);
    this.addMessage({ kind: "owner" }, `${s.name} left the team. Their open orders went back on the board.`, null, true);
    return { ok: true };
  }

  reportQuota(staff: Staff, a: Args) {
    const level = int(a.percent_left, "percent_left");
    if (level < 0 || level > 100) throw new HttpError(400, "percent_left must be 0 to 100");
    this.sql.exec("UPDATE staff SET quota=?, quota_note=?, quota_at=? WHERE id=?", level, clamp(str(a.note), 200) || null, now(), staff.id);
    return { ok: true, percent_left: level };
  }

  // ---------- Orders (tasks) ----------

  getTask(id: number): Task {
    const t = this.one<Task>("SELECT * FROM tasks WHERE id=?", id);
    if (!t) throw new HttpError(404, `Order #${id} not found`);
    return t;
  }

  listTasks(a: Args, me?: Staff) {
    const status = str(a.status);
    if (status && !STATUSES.includes(status as Status)) throw new HttpError(400, "status must be todo, doing, review or done");
    let q = "SELECT t.*, s.name AS assignee FROM tasks t LEFT JOIN staff s ON s.id=t.assignee_id WHERE 1=1";
    const args: unknown[] = [];
    if (status) {
      q += " AND t.status=?";
      args.push(status);
    } else q += " AND t.status!='done'";
    if (a.mine && me) {
      q += " AND t.assignee_id=?";
      args.push(me.id);
    }
    return this.all<Task & { assignee: string | null }>(q + " ORDER BY t.id DESC LIMIT 50", ...args).map(({ assignee_id, ...t }) => ({
      ...t,
      created_at: new Date(t.created_at).toISOString(),
      updated_at: new Date(t.updated_at).toISOString(),
    }));
  }

  async createTask(actor: Actor, a: Args) {
    const title = clamp(str(a.title).trim(), 200);
    if (!title) throw new HttpError(400, "An order needs a title");
    const assignee = a.assignee != null && a.assignee !== "" ? this.findStaff(a.assignee) : null;
    if (assignee && actor.kind === "staff" && !isBoss(actor) && assignee.id !== actor.staff.id) {
      throw new HttpError(403, "Only the owner or the chief can give orders to other staff");
    }
    const t = now();
    const task = this.one<Task>(
      "INSERT INTO tasks (title, detail, assignee_id, created_by, due, created_at, updated_at) VALUES (?,?,?,?,?,?,?) RETURNING *",
      title,
      clamp(str(a.detail), 8000),
      assignee?.id ?? null,
      actorName(actor),
      clamp(str(a.due).trim(), 40) || null,
      t,
      t,
    )!;
    this.addMessage(actor, `Created order #${task.id}${assignee ? ` for ${assignee.name}` : ""}`, task.id, true);
    if (assignee && !(actor.kind === "staff" && actor.staff.id === assignee.id)) {
      await this.ring(assignee.id, `New order #${task.id} from ${actorName(actor)}: ${title}`);
    }
    return task;
  }

  async addAttachment(actor: Actor, taskId: number, name: string, mime: string, bytes: Uint8Array) {
    const task = this.getTask(taskId);
    const photo = this.storePhoto(actor, taskId, name, mime, bytes);
    this.addMessage(actor, `📷 ${actorName(actor)} added a photo: ${name}`, taskId, true);
    if (task.assignee_id && !(actor.kind === "staff" && actor.staff.id === task.assignee_id)) {
      await this.ring(task.assignee_id, `${actorName(actor)} added a photo to order #${taskId}: ${task.title}`);
    }
    return photo;
  }

  /** Checks and saves a photo for an order, or for the team chat (taskId CHAT_PHOTO). */
  private storePhoto(actor: Actor, taskId: number, name: string, mime: string, bytes: Uint8Array) {
    const looksRight = PHOTO_SIGNATURES[mime];
    if (!looksRight) throw new HttpError(415, "Only photos can be added (JPEG, PNG, WebP or GIF)");
    if (!looksRight(bytes)) throw new HttpError(415, "That file isn't the kind of photo it says it is");
    if (bytes.byteLength > PHOTO_MAX_BYTES) throw new HttpError(413, PHOTO_TOO_BIG);
    const count = this.one<{ n: number }>("SELECT COUNT(*) n FROM attachments WHERE task_id=?", taskId)!.n;
    if (taskId !== CHAT_PHOTO && count >= PHOTOS_PER_ORDER) throw new HttpError(400, `An order can have up to ${PHOTOS_PER_ORDER} photos`);
    const used = this.one<{ n: number | null }>("SELECT SUM(size) n FROM attachments")!.n ?? 0;
    if (used + bytes.byteLength > PHOTO_STORAGE_CAP) throw new HttpError(507, "Photo storage is full. Delete some old photos first.");
    const row = this.one<{ id: number }>(
      "INSERT INTO attachments (task_id, name, mime, size, data, added_by, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id",
      taskId,
      name,
      mime,
      bytes.byteLength,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      actorName(actor),
      now(),
    )!;
    return { id: row.id, name, size: bytes.byteLength };
  }

  /** Downloads a photo from a public link (e.g. an AI image tool's result) and adds it to an order. */
  async addAttachmentFromUrl(me: Staff, taskId: number, link: unknown, nameIn: unknown) {
    this.getTask(taskId);
    const allowLocal = this.env.ALLOW_LOCAL_WAKE === "true";
    let target = checkPublicUrl(str(link).trim(), allowLocal, "photo link");
    let res: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(target, { headers: { "user-agent": "ai-agent-restaurant/0.1", accept: "image/*" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) break;
      target = checkPublicUrl(new URL(next, target).toString(), allowLocal, "photo link");
      res = undefined;
    }
    if (!res) throw new HttpError(400, "That photo link redirects too many times");
    if (!res.ok) throw new HttpError(400, `The photo link answered ${res.status}. Use a link anyone can open without signing in.`);
    if (Number(res.headers.get("content-length") ?? 0) > PHOTO_MAX_BYTES) throw new HttpError(413, PHOTO_TOO_BIG);
    const bytes = await readCapped(res, PHOTO_MAX_BYTES);
    const fromPath = decodeURIComponent(new URL(target).pathname.split("/").pop() || "");
    const name = clamp(str(nameIn).trim() || fromPath || "photo", 80);
    return this.addAttachment({ kind: "staff", staff: me }, taskId, name, photoMime(bytes), bytes);
  }

  listAttachments(taskId: number) {
    return this.all<AttachmentInfo>("SELECT id, name, mime, size, added_by FROM attachments WHERE task_id=? ORDER BY id", taskId).map((a) => ({
      photo_id: a.id,
      name: a.name,
      size_kb: Math.round(a.size / 1024),
      added_by: a.added_by,
    }));
  }

  getAttachment(id: number) {
    const a = this.one<AttachmentInfo & { data: ArrayBuffer }>("SELECT * FROM attachments WHERE id=?", id);
    if (!a) throw new HttpError(404, `Photo #${id} not found`);
    return a;
  }

  claimTask(staff: Staff, id: number) {
    const task = this.getTask(id);
    if (task.status === "done") throw new HttpError(409, `Order #${id} is already done`);
    if (task.assignee_id && task.assignee_id !== staff.id) {
      const holder = this.one<Staff>("SELECT name FROM staff WHERE id=?", task.assignee_id);
      throw new HttpError(409, `Order #${id} is already taken by ${holder?.name ?? "someone"}`);
    }
    // Durable Objects run one request at a time, so this check-then-write cannot race.
    this.sql.exec(
      "UPDATE tasks SET assignee_id=?, status=CASE WHEN status='todo' THEN 'doing' ELSE status END, updated_at=? WHERE id=?",
      staff.id,
      now(),
      id,
    );
    this.addMessage({ kind: "staff", staff }, `${staff.name} took this order`, id, true);
    return this.getTask(id);
  }

  async updateTask(actor: Actor, id: number, a: Args) {
    const task = this.getTask(id);
    if (actor.kind === "staff" && !isBoss(actor) && task.assignee_id !== actor.staff.id) {
      throw new HttpError(403, "This order belongs to someone else. Claim it first, or ask the chief.");
    }
    const changes: string[] = [];
    const set = (col: string, val: unknown) => this.sql.exec(`UPDATE tasks SET ${col}=? WHERE id=?`, val as SqlStorageValue, id);

    if (a.title != null && str(a.title).trim()) set("title", clamp(str(a.title).trim(), 200));
    if (a.detail != null) set("detail", clamp(str(a.detail), 8000));
    if (a.due !== undefined) set("due", clamp(str(a.due).trim(), 40) || null);
    if (a.status != null && a.status !== task.status) {
      const status = str(a.status) as Status;
      if (!STATUSES.includes(status)) throw new HttpError(400, "status must be todo, doing, review or done");
      if (status === "done" && actor.kind !== "owner") {
        throw new HttpError(403, "Only the owner marks orders done. Move it to 'review' when it is ready.");
      }
      set("status", status);
      changes.push(`moved to ${status}`);
    }
    if (a.tokens_used != null && a.tokens_used !== "") {
      const n = int(a.tokens_used, "tokens_used");
      if (n < 0) throw new HttpError(400, "tokens_used cannot be negative");
      this.sql.exec("UPDATE tasks SET tokens_used=tokens_used+? WHERE id=?", n, id);
      if (n) changes.push(`+${n.toLocaleString("en")} tokens`);
    }
    let ringId: number | null = null;
    if (a.assignee !== undefined) {
      if (!isBoss(actor)) throw new HttpError(403, "Only the owner or the chief can hand orders to someone");
      const next = a.assignee === null || a.assignee === "" ? null : this.findStaff(a.assignee);
      if ((next?.id ?? null) !== task.assignee_id) {
        set("assignee_id", next?.id ?? null);
        changes.push(next ? `handed to ${next.name}` : "unassigned");
        if (next && !(actor.kind === "staff" && actor.staff.id === next.id)) ringId = next.id;
      }
    }
    set("updated_at", now());
    const note = a.note != null ? clamp(str(a.note).trim(), 4000) : "";
    if (note) this.addMessage(actor, note, id);
    if (changes.length) this.addMessage(actor, `${actorName(actor)}: ${changes.join(", ")}`, id, true);
    if (ringId) await this.ring(ringId, `Order #${id} was handed to you by ${actorName(actor)}: ${task.title}`);
    if (note) await this.ringMentions(actor, `Order #${id}: ${note}`, ringId);
    return this.getTask(id);
  }

  // ---------- Chat ----------

  private addMessage(actor: Actor, body: string, taskId: number | null, system = false, photoId: number | null = null) {
    this.sql.exec(
      "INSERT INTO messages (task_id, author, author_staff_id, kind, body, photo_id, created_at) VALUES (?,?,?,?,?,?,?)",
      taskId,
      actorName(actor),
      actor.kind === "staff" ? actor.staff.id : null,
      system ? "system" : "note",
      body,
      photoId,
      now(),
    );
  }

  async postMessage(actor: Actor, bodyIn: unknown, taskIn: unknown, photoIn?: unknown) {
    const taskId = taskIn == null || taskIn === "" ? null : this.getTask(int(taskIn, "task_id")).id;
    let photoId: number | null = null;
    if (photoIn != null && photoIn !== "") {
      if (taskId) throw new HttpError(400, "Add photos to an order on the order itself");
      photoId = int(photoIn, "photo_id");
      const p = this.one<{ task_id: number }>("SELECT task_id FROM attachments WHERE id=?", photoId);
      if (p?.task_id !== CHAT_PHOTO) throw new HttpError(400, `Photo #${photoId} isn't a team chat photo`);
      if (this.one("SELECT id FROM messages WHERE photo_id=?", photoId)) throw new HttpError(409, `Photo #${photoId} is already in the chat`);
    }
    const body = clamp(str(bodyIn).trim(), 4000) || (photoId ? PHOTO_ONLY : "");
    if (!body) throw new HttpError(400, "Message is empty");
    this.addMessage(actor, body, taskId, false, photoId);
    await this.ringMentions(actor, body);
    return { ok: true };
  }

  /** Wakes everyone @mentioned in body, except skipId (already being rung). */
  private async ringMentions(actor: Actor, body: string, skipId?: number | null) {
    // Only the owner and the chief can wake people with @mentions, so bots can't wake each other in a loop.
    if (!isBoss(actor)) return;
    for (const s of this.all<Staff>("SELECT * FROM staff WHERE active=1")) {
      if ((actor.kind === "staff" && actor.staff.id === s.id) || s.id === skipId) continue;
      const re = new RegExp(`@${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu");
      if (re.test(body)) await this.ring(s.id, `${actorName(actor)} mentioned you: ${clamp(body, 140)}`);
    }
  }

  readMessages(a: Args) {
    const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
    const taskId = a.task_id == null || a.task_id === "" ? null : int(a.task_id, "task_id");
    type Row = { id: number; author: string; body: string; photo_id: number | null; created_at: number };
    const rows = taskId
      ? this.all<Row>("SELECT id, author, body, kind, photo_id, created_at FROM messages WHERE task_id=? ORDER BY id DESC LIMIT ?", taskId, limit)
      : this.all<Row>("SELECT id, author, body, kind, photo_id, created_at FROM messages WHERE task_id IS NULL ORDER BY id DESC LIMIT ?", limit);
    return rows.reverse().map(withPhoto);
  }

  // ---------- Inbox ----------

  checkInbox(staff: Staff, markRead: boolean) {
    const since = staff.inbox_at ?? 0;
    const events = this.all<{ id: number; created_at: number }>(
      "SELECT id, source_name, kind, summary, excerpt, created_at FROM events WHERE read_at IS NULL AND (staff_id=? OR (staff_id IS NULL AND ?=1)) ORDER BY id LIMIT 30",
      staff.id,
      staff.role === "chief" ? 1 : 0,
    );
    const iso = <T extends { created_at: number }>(r: T) => ({ ...r, created_at: new Date(r.created_at).toISOString() });
    const result = {
      you: { name: staff.name, role: staff.role },
      notifications: events.map(iso),
      my_open_orders: this.all(
        "SELECT id, title, status, due, detail, (SELECT COUNT(*) FROM attachments a WHERE a.task_id=tasks.id) AS photos FROM tasks WHERE assignee_id=? AND status IN ('todo','doing') ORDER BY id",
        staff.id,
      ),
      unclaimed_orders: this.all("SELECT id, title, due FROM tasks WHERE assignee_id IS NULL AND status='todo' ORDER BY id LIMIT 10"),
      approval_answers: this.all("SELECT id, action, status, note FROM approvals WHERE staff_id=? AND status!='pending' AND decided_at>?", staff.id, since),
      new_messages: this.all<{ photo_id: number | null; created_at: number }>(
        "SELECT id, task_id, author, body, photo_id, created_at FROM messages WHERE created_at>? AND kind='note' AND (author_staff_id IS NULL OR author_staff_id!=?) ORDER BY id LIMIT 30",
        since,
        staff.id,
      ).map(withPhoto),
    };
    if (markRead) {
      const t = now();
      if (events.length) this.sql.exec(`UPDATE events SET read_at=? WHERE id IN (${events.map(() => "?").join(",")})`, t, ...events.map((e) => e.id));
      this.sql.exec("UPDATE staff SET inbox_at=? WHERE id=?", t, staff.id);
    }
    return result;
  }

  getSource(id: string): Source | undefined {
    return this.one<Source>("SELECT * FROM sources WHERE id=?", id);
  }

  setNotionToken(id: string, token: string) {
    this.sql.exec("UPDATE sources SET notion_token=? WHERE id=?", clamp(token, 200), id);
  }

  /** Stores an incoming notification, routes it to the right staff member and rings their doorbell. */
  async recordEvent(source: Source, e: { kind: string; summary: string; excerpt?: string; deliveryId?: string | null; ring?: boolean }) {
    if (e.deliveryId) {
      const fresh = this.one("INSERT OR IGNORE INTO deliveries (id, at) VALUES (?, ?) RETURNING id", `${source.id}:${e.deliveryId}`, now());
      if (!fresh) return { ok: true, duplicate: true };
    }
    const staffId = source.route_staff_id ?? this.chief()?.id ?? null;
    const t = now();
    const ev = this.one<{ id: number }>(
      "INSERT INTO events (source_id, source_name, kind, summary, excerpt, staff_id, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id",
      source.id,
      source.name,
      clamp(e.kind, 60),
      clamp(e.summary, 300),
      clamp(e.excerpt ?? "", 2000),
      staffId,
      t,
    )!;
    this.sql.exec("UPDATE sources SET last_event_at=? WHERE id=?", t, source.id);
    if (staffId && e.ring !== false) await this.ring(staffId, `${source.name}: ${clamp(e.summary, 140)}`);
    return { ok: true, event_id: ev.id };
  }

  // ---------- Sources ----------

  private addSource(a: Args) {
    const name = clamp(str(a.name).trim(), 40);
    const kind = str(a.kind);
    if (!name) throw new HttpError(400, "Give the source a name");
    if (!["github", "notion", "generic"].includes(kind)) throw new HttpError(400, "Kind must be github, notion or generic");
    const route = a.route_to ? this.findStaff(a.route_to).id : null;
    const id = randomToken(9);
    // Standard Webhooks style secret, so tools like Herdr's notify plugin can sign with it.
    const secret = "whsec_" + b64(randomBytes(24));
    this.sql.exec(
      "INSERT INTO sources (id, name, kind, secret, route_staff_id, created_at) VALUES (?,?,?,?,?,?)",
      id,
      name,
      kind,
      secret,
      route,
      now(),
    );
    return this.getSource(id);
  }

  private updateSource(id: string, a: Args) {
    if (!this.getSource(id)) throw new HttpError(404, "Source not found");
    if (a.route_to !== undefined) {
      const route = a.route_to ? this.findStaff(a.route_to).id : null;
      this.sql.exec("UPDATE sources SET route_staff_id=? WHERE id=?", route, id);
    }
    return this.getSource(id);
  }

  // ---------- Recipe book ----------

  listRecipes() {
    return this.all("SELECT id, title, origin, updated_by, length(body) AS chars FROM recipes ORDER BY title");
  }

  readRecipe(ref: unknown) {
    const r = str(ref).trim();
    const row = /^\d+$/.test(r)
      ? this.one("SELECT * FROM recipes WHERE id=?", Number(r))
      : this.one("SELECT * FROM recipes WHERE title=?", r);
    if (!row) throw new HttpError(404, `No recipe called "${r}"`);
    return row;
  }

  saveRecipe(actor: Actor, a: Args) {
    const title = clamp(str(a.title).trim(), 120);
    const body = str(a.body);
    if (!title) throw new HttpError(400, "A recipe needs a title");
    if (body.length > RECIPE_MAX) throw new HttpError(400, `Recipes can be up to ${RECIPE_MAX.toLocaleString("en")} characters`);
    const fromNotion = this.one<{ notion_url: string | null }>("SELECT notion_url FROM recipes WHERE title=? AND origin='notion'", title);
    if (fromNotion) throw new HttpError(409, `"${title}" comes from Notion, the master copy. Edit it there: ${fromNotion.notion_url ?? "your Skills database"}`);
    const count = this.one<{ n: number }>("SELECT COUNT(*) n FROM recipes")!.n;
    if (count >= 200 && !this.one("SELECT 1 FROM recipes WHERE title=?", title)) throw new HttpError(400, "The recipe book is full (200)");
    this.sql.exec(
      "INSERT INTO recipes (title, body, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(title) DO UPDATE SET body=excluded.body, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
      title,
      body,
      actorName(actor),
      now(),
    );
    return this.readRecipe(title);
  }

  // ---------- Approvals ----------

  requestApproval(staff: Staff, a: Args) {
    const action = clamp(str(a.action).trim(), 500);
    if (!action) throw new HttpError(400, "Say what you want to do");
    const taskId = a.task_id == null || a.task_id === "" ? null : this.getTask(int(a.task_id, "task_id")).id;
    const row = this.one<{ id: number }>(
      "INSERT INTO approvals (staff_id, task_id, action, reason, created_at) VALUES (?,?,?,?,?) RETURNING id",
      staff.id,
      taskId,
      action,
      clamp(str(a.reason), 2000),
      now(),
    )!;
    return { approval_id: row.id, status: "pending", hint: "The owner will decide. You'll be woken (if you have a doorbell) or see the answer in check_inbox." };
  }

  getApproval(staff: Staff, id: number) {
    const row = this.one("SELECT id, action, status, note FROM approvals WHERE id=? AND staff_id=?", id, staff.id);
    if (!row) throw new HttpError(404, `Approval #${id} not found`);
    return row;
  }

  private async decideApproval(id: number, a: Args) {
    const row = this.one<{ staff_id: number; status: string; action: string }>("SELECT * FROM approvals WHERE id=?", id);
    if (!row) throw new HttpError(404, "Approval not found");
    if (row.status !== "pending") throw new HttpError(409, "Already decided");
    const status = a.approve ? "approved" : "denied";
    this.sql.exec("UPDATE approvals SET status=?, note=?, decided_at=? WHERE id=?", status, clamp(str(a.note), 500) || null, now(), id);
    await this.ring(row.staff_id, `Approval #${id} ${status}: ${clamp(row.action, 120)}`);
    return { ok: true, status };
  }

  // ---------- Doorbell (wake staff via webhook) ----------

  /** Queues a wake-up call. Several rings before delivery collapse into one, so a busy minute costs one wake. */
  async ring(staffId: number, reason: string, force = false) {
    const s = this.one<Staff>("SELECT * FROM staff WHERE id=? AND active=1", staffId);
    if (!s) throw new HttpError(404, "Staff not found");
    if (!s.wake_url) {
      if (force) throw new HttpError(400, `${s.name} has no doorbell link yet. They will see new work next time they check in.`);
      return { ok: true, rang: false };
    }
    const pending = this.one("SELECT 1 FROM outbox WHERE staff_id=? AND status='pending'", s.id);
    if (!pending) {
      this.sql.exec("INSERT INTO outbox (staff_id, reason, next_at, created_at) VALUES (?,?,?,?)", s.id, clamp(reason, 300), now(), now());
      await this.scheduleAlarm();
    }
    return { ok: true, rang: true };
  }

  private async scheduleAlarm() {
    const ring = this.one<{ t: number | null }>("SELECT MIN(next_at) t FROM outbox WHERE status='pending'")?.t ?? Infinity;
    const notion = this.notionConfigured ? Number(this.getMeta("notion_due")) || Infinity : Infinity;
    const daily = Number(this.getMeta("daily_check_due")) || Infinity;
    const next = Math.min(ring, notion, daily);
    if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, now()));
  }

  /**
   * Backup for missed rings, in plain SQL with no AI. Rings staff with a doorbell only if something
   * came in since they last checked their inbox (a failed ring, a helper's @mention, a new order),
   * so a quiet day costs no tokens.
   */
  async dailyCheck() {
    const rang: { name: string; reason: string }[] = [];
    for (const s of this.all<Staff>("SELECT * FROM staff WHERE active=1 AND wake_url IS NOT NULL AND wake_url!=''")) {
      const since = s.inbox_at ?? 0;
      const count = (q: string, ...args: unknown[]) => this.one<{ n: number }>(q, ...args)?.n ?? 0;
      const waiting: string[] = [];
      const add = (n: number, what: string) => n && waiting.push(`${n} ${what}${n > 1 ? "s" : ""}`);
      add(
        count("SELECT COUNT(*) n FROM events WHERE read_at IS NULL AND created_at>? AND (staff_id=? OR (staff_id IS NULL AND ?=1))", since, s.id, s.role === "chief" ? 1 : 0),
        "notification",
      );
      add(count("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status='todo' AND updated_at>?", s.id, since), "new order");
      add(count("SELECT COUNT(*) n FROM approvals WHERE staff_id=? AND status!='pending' AND decided_at>?", s.id, since), "approval answer");
      const re = new RegExp(`@${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu");
      const notes = this.all<{ body: string }>(
        "SELECT body FROM messages WHERE kind='note' AND created_at>? AND (author_staff_id IS NULL OR author_staff_id!=?) AND instr(lower(body), lower(?))>0",
        since,
        s.id,
        "@" + s.name,
      );
      add(notes.filter((m) => re.test(m.body)).length, "@mention");
      if (!waiting.length) continue;
      const reason = `Daily check: ${waiting.join(", ")} since you last checked in`;
      await this.ring(s.id, reason);
      rang.push({ name: s.name, reason });
    }
    const result = { at: new Date().toISOString(), rang };
    this.setMeta("daily_check_last", JSON.stringify(result));
    return result;
  }

  async alarm() {
    const notionDue = Number(this.getMeta("notion_due"));
    if (this.notionConfigured && notionDue && notionDue <= now()) {
      await this.syncNotion().catch(() => {}); // errors are saved for the dashboard
    }
    const dailyDue = Number(this.getMeta("daily_check_due"));
    if (dailyDue && dailyDue <= now()) {
      this.setMeta("daily_check_due", nextDailyCheck(dailySchedule(this.env)));
      await this.dailyCheck().catch((e) => console.error("daily check", e));
    }
    const due = this.all<{ id: number; staff_id: number; reason: string; attempts: number }>(
      "SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 20",
      now(),
    );
    for (const row of due) {
      try {
        await this.deliver(row);
        this.sql.exec("UPDATE outbox SET status='sent', attempts=attempts+1, sent_at=?, last_error=NULL WHERE id=?", now(), row.id);
      } catch (e) {
        const attempts = row.attempts + 1;
        const msg = clamp(e instanceof Error ? e.message : String(e), 300);
        if (attempts > RETRY_SECONDS.length) {
          this.sql.exec("UPDATE outbox SET status='failed', attempts=?, last_error=? WHERE id=?", attempts, msg, row.id);
        } else {
          this.sql.exec("UPDATE outbox SET attempts=?, last_error=?, next_at=? WHERE id=?", attempts, msg, now() + RETRY_SECONDS[attempts - 1] * 1000, row.id);
        }
      }
    }
    const old = now() - 7 * DAY;
    this.sql.exec("DELETE FROM deliveries WHERE at<?", old);
    this.sql.exec("DELETE FROM sessions WHERE expires_at<?", now());
    this.sql.exec("DELETE FROM login_failures WHERE at<?", old);
    this.sql.exec("DELETE FROM outbox WHERE status!='pending' AND created_at<?", old);
    // Chat photos that were uploaded but never sent with a message.
    this.sql.exec(
      "DELETE FROM attachments WHERE task_id=? AND created_at<? AND id NOT IN (SELECT photo_id FROM messages WHERE photo_id IS NOT NULL)",
      CHAT_PHOTO,
      now() - DAY,
    );
    await this.scheduleAlarm();
  }

  private async deliver(row: { id: number; staff_id: number; reason: string }) {
    const s = this.one<Staff>("SELECT * FROM staff WHERE id=? AND active=1", row.staff_id);
    if (!s?.wake_url) throw new Error("No doorbell link");
    const url = checkWakeUrl(s.wake_url, this.env.ALLOW_LOCAL_WAKE === "true");
    // Claude scheduled tasks (routines) take an API trigger with their own headers and a plain `text` field.
    const target = new URL(url);
    const routine = target.hostname === "api.anthropic.com" && /^\/v1\/claude_code\/routines\/[\w-]+\/fire$/.test(target.pathname);
    const body = routine
      ? JSON.stringify({ text: `${this.restaurantName} doorbell for ${s.name}: ${row.reason}` })
      : JSON.stringify({
          type: "restaurant.wake",
          restaurant: this.restaurantName,
          staff: s.name,
          reason: row.reason,
          at: new Date().toISOString(),
          next_step: "Call the check_inbox tool on the restaurant MCP server, then do your work.",
        });
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "ai-agent-restaurant/0.1" };
    if (routine) {
      headers["anthropic-beta"] = "experimental-cc-routine-2026-04-01";
      headers["anthropic-version"] = "2023-06-01";
    }
    if (s.wake_auth) headers.authorization = /^(bearer|basic|token)\s/i.test(s.wake_auth) ? s.wake_auth : `Bearer ${s.wake_auth}`;
    if (s.wake_secret) {
      // Standard Webhooks signature: v1,base64(HMAC-SHA256(secret, id.timestamp.body))
      const id = `ring_${row.id}`;
      const ts = Math.floor(now() / 1000).toString();
      headers["webhook-id"] = id;
      headers["webhook-timestamp"] = ts;
      headers["webhook-signature"] = "v1," + (await hmacB64(s.wake_secret, `${id}.${ts}.${body}`));
    }
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000), redirect: "manual" });
    if (res.status >= 300) throw new Error(`Doorbell answered ${res.status}`);
  }
}

function sessionCookie(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

function cookie(value: string, maxAgeSeconds: number): string {
  return `session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

/** Message for AI staff: ISO time, and photo_id only when there is a photo (open it with view_photo). */
function withPhoto<T extends { photo_id: number | null; created_at: number }>({ photo_id, created_at, ...rest }: T) {
  return { ...rest, ...(photo_id ? { photo_id } : {}), created_at: new Date(created_at).toISOString() };
}

/** Works out a photo's type from its first bytes, so senders don't have to label it. */
function photoMime(bytes: Uint8Array): string {
  return Object.keys(PHOTO_SIGNATURES).find((mime) => PHOTO_SIGNATURES[mime](bytes)) ?? "application/octet-stream";
}

/** Reads a download but stops as soon as it gets bigger than `max`. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, PHOTO_TOO_BIG);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
