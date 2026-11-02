import type { Restaurant, Source } from "./restaurant";
import { HttpError, b64decode, bearer, clamp, hmacB64, hmacHex, json, readLimited, safeEqual } from "./util";

// Incoming notifications ("the mailbox"). Each source has its own address:
//   POST /hook/<source id>
// and is checked with the method its sender supports before anything is stored.

type Payload = Record<string, any>;

export async function handleHook(r: Restaurant, req: Request, sourceId: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Send a POST" }, 405);
  const source = sourceId ? r.getSource(sourceId) : undefined;
  if (!source) return json({ error: "Unknown source" }, 404);
  const raw = await readLimited(req, 256 * 1024);
  let payload: Payload = {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") payload = v;
  } catch {}

  switch (source.kind) {
    case "github":
      return github(r, source, req, raw, payload);
    case "notion":
      return notion(r, source, req, raw, payload);
    default:
      return generic(r, source, req, raw, payload);
  }
}

async function github(r: Restaurant, source: Source, req: Request, raw: string, p: Payload) {
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + (await hmacHex(source.secret, raw));
  if (!safeEqual(sig, expected)) throw new HttpError(401, "Bad GitHub signature. Check the secret, and set content type to application/json.");
  const event = req.headers.get("x-github-event") ?? "unknown";
  const repo = p.repository?.full_name ?? "";
  const link = p.pull_request?.html_url ?? p.issue?.html_url ?? p.workflow_run?.html_url ?? p.compare ?? p.repository?.html_url ?? "";
  const result = await r.recordEvent(source, {
    kind: `github.${event}`,
    summary: githubSummary(event, p, repo),
    excerpt: link,
    deliveryId: req.headers.get("x-github-delivery"),
    ring: event !== "ping",
  });
  return json(result);
}

function githubSummary(event: string, p: Payload, repo: string): string {
  const action = p.action ? ` ${p.action}` : "";
  switch (event) {
    case "ping":
      return `GitHub connected (${repo || "test ping"})`;
    case "pull_request":
      return `PR #${p.number}${action}: ${p.pull_request?.title ?? ""} (${repo})`;
    case "pull_request_review":
      return `Review ${p.review?.state ?? ""} on PR #${p.pull_request?.number} by ${p.review?.user?.login ?? "?"} (${repo})`;
    case "issues":
      return `Issue #${p.issue?.number}${action}: ${p.issue?.title ?? ""} (${repo})`;
    case "issue_comment":
      return `Comment on #${p.issue?.number} by ${p.comment?.user?.login ?? "?"}: ${clamp(p.comment?.body, 140)}`;
    case "push":
      return `Push to ${String(p.ref ?? "").replace("refs/heads/", "")}: ${p.commits?.length ?? 0} commit(s) (${repo})`;
    case "workflow_run":
      return `CI "${p.workflow_run?.name ?? ""}" ${p.workflow_run?.conclusion ?? p.action ?? ""} (${repo})`;
    default:
      return `GitHub ${event}${action} (${repo})`;
  }
}

async function notion(r: Restaurant, source: Source, req: Request, raw: string, p: Payload) {
  // Step 1 of Notion's setup: it sends a one-time verification token that the owner pastes back into Notion.
  if (typeof p.verification_token === "string" && Object.keys(p).length === 1) {
    if (source.notion_token) throw new HttpError(409, "This source is already verified");
    r.setNotionToken(source.id, p.verification_token);
    await r.recordEvent(source, {
      kind: "notion.verification",
      summary: "Notion sent a verification token. Copy it from the Sources tab and paste it into Notion.",
      ring: false,
    });
    return json({ ok: true });
  }
  if (!source.notion_token) throw new HttpError(401, "Notion source is not verified yet");
  const sig = req.headers.get("x-notion-signature") ?? "";
  if (!safeEqual(sig, "sha256=" + (await hmacHex(source.notion_token, raw)))) throw new HttpError(401, "Bad Notion signature");
  const type = String(p.type ?? "event");
  const entity = p.entity ? `${p.entity.type} ${p.entity.id}` : "";
  // A page changed somewhere in Notion: re-check the Skills database in a few seconds.
  // Several edits in a row collapse into one sync, and unchanged pages are skipped.
  if (type.startsWith("page.") || type.startsWith("data_source.") || type.startsWith("database.")) await r.requestNotionSync(5000);
  return json(
    await r.recordEvent(source, {
      kind: `notion.${type}`,
      summary: `Notion ${type.replace(/[._]/g, " ")}${entity ? ` (${entity})` : ""}`,
      excerpt: raw,
      deliveryId: typeof p.id === "string" ? p.id : null,
    }),
  );
}

async function generic(r: Restaurant, source: Source, req: Request, raw: string, p: Payload) {
  // Accepts either the secret as ?key=... / Bearer token, or a Standard Webhooks signature.
  const key = new URL(req.url).searchParams.get("key") ?? bearer(req) ?? "";
  const ok = (key && safeEqual(key, source.secret)) || (await verifyStandardWebhook(source.secret, req, raw));
  if (!ok) throw new HttpError(401, "Missing or wrong key");
  const summary =
    pick(p, ["summary", "title", "message", "text", "subject", "description", "event", "type"]) || clamp(raw.trim(), 200) || "(empty notification)";
  return json(
    await r.recordEvent(source, {
      kind: String(pick(p, ["type", "event"]) || "notification"),
      summary,
      excerpt: raw,
      deliveryId: req.headers.get("webhook-id") ?? req.headers.get("x-delivery-id"),
    }),
  );
}

function pick(p: Payload, keys: string[]): string {
  for (const k of keys) if (typeof p[k] === "string" && p[k].trim()) return clamp(p[k].trim(), 300);
  return "";
}

async function verifyStandardWebhook(secret: string, req: Request, raw: string): Promise<boolean> {
  const id = req.headers.get("webhook-id");
  const ts = req.headers.get("webhook-timestamp");
  const sig = req.headers.get("webhook-signature");
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const keyBytes = secret.startsWith("whsec_") ? b64decode(secret.slice(6)) : new TextEncoder().encode(secret);
  const expected = await hmacB64(keyBytes, `${id}.${ts}.${raw}`);
  return sig.split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && !!value && safeEqual(value, expected);
  });
}
