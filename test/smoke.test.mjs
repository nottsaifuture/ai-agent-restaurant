// End-to-end test: starts the restaurant with `wrangler dev` on a fresh database,
// then walks through the owner dashboard API, the MCP tools, webhooks and the doorbell.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const BELL_PORT = 8798;
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BASE = `http://localhost:${PORT}`;
const PASSWORD = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1].trim();

let worker, bell, persistDir, cookie;
const rings = [];

// A tiny fake of the Notion API, served by the same local server as the doorbell.
const fakeNotion = {
  calls: [],
  pages: [
    { id: "page-1", title: "How we write PRs", published: true, edited: "2026-10-30T10:00:00.000Z", blocks: [["heading_2", "Rules"], ["bulleted_list_item", "Keep PRs small"], ["code", "npm test"], ["table", [["Move", "Use"], ["Pan", "Reveal a|b"]]]] },
    { id: "page-2", title: "Secret draft", published: false, edited: "2026-10-30T10:00:00.000Z", blocks: [["paragraph", "not ready"]] },
    { id: "page-3", title: "House rules", published: true, edited: "2026-10-30T10:00:00.000Z", blocks: [["paragraph", "From Notion"]] },
  ],
};
const rt = (s) => [{ plain_text: s, annotations: {} }];
function notionApi(req, res) {
  fakeNotion.calls.push(`${req.method} ${req.url}`);
  const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.headers.authorization !== "Bearer test-notion-token" || !req.headers["notion-version"]) return send(401, { message: "unauthorized" });
  if (req.url === "/v1/databases/db1") return send(200, { object: "database", data_sources: [{ id: "ds1", name: "Skills" }] });
  if (req.method === "POST" && req.url === "/v1/data_sources/ds1/query") {
    return send(200, {
      object: "list", has_more: false, next_cursor: null,
      results: fakeNotion.pages.map((p) => ({
        object: "page", id: p.id, url: `https://www.notion.so/${p.id}`, in_trash: false, last_edited_time: p.edited,
        properties: { Name: { type: "title", title: rt(p.title) }, Published: { type: "checkbox", checkbox: p.published } },
      })),
    });
  }
  const m = req.url.match(/^\/v1\/blocks\/([^/]+)\/children/);
  const page = m && fakeNotion.pages.find((p) => p.id === m[1]);
  if (page) {
    return send(200, {
      object: "list", has_more: false,
      results: page.blocks.map(([type, text], i) =>
        type === "table"
          ? { id: `${page.id}-b${i}`, type, has_children: true, table: { table_width: text[0].length, has_column_header: true } }
          : { id: `${page.id}-b${i}`, type, has_children: false, [type]: { rich_text: rt(text), language: "bash" } }),
    });
  }
  const t = m && m[1].match(/^(.+)-b(\d+)$/);
  const table = t && fakeNotion.pages.find((p) => p.id === t[1])?.blocks[Number(t[2])];
  if (table?.[0] === "table") return send(200, { object: "list", has_more: false, results: table[1].map((row) => ({ type: "table_row", table_row: { cells: row.map(rt) } })) });
  send(404, { message: "not found" });
}

before(async () => {
  persistDir = mkdtempSync(join(tmpdir(), "restaurant-test-"));
  bell = createServer((req, res) => {
    if (req.url.startsWith("/v1/")) return notionApi(req, res);
    if (req.url === "/img/cha-chaan-teng.png") return res.writeHead(200, { "content-type": "image/png" }).end(TINY_PNG);
    if (req.url === "/img/moved") return res.writeHead(302, { location: "/img/cha-chaan-teng.png" }).end();
    if (req.url === "/img/page") return res.writeHead(200, { "content-type": "text/html" }).end("<html>not an image</html>");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      rings.push({ headers: req.headers, body });
      res.end("ok");
    });
  }).listen(BELL_PORT);
  const notionVars = ["--var", "NOTION_TOKEN:test-notion-token", "--var", "NOTION_SKILLS_DB:db1", "--var", `NOTION_API_BASE:http://localhost:${BELL_PORT}`];
  worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", persistDir, "--show-interactive-dev-session=false", ...notionVars], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stdout.on("data", (d) => (log += d));
  worker.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start:\n" + log);
});

after(() => {
  worker?.kill();
  bell?.close();
  rmSync(persistDir, { recursive: true, force: true });
});

async function api(path, { method = "GET", body, auth = true } = {}) {
  const res = await fetch(BASE + "/api/" + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(auth && cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

let rpcId = 0;
async function mcp(key, method, params) {
  const res = await fetch(`${BASE}/mcp/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, data: res.status === 200 ? await res.json() : null };
}
async function tool(key, name, args = {}) {
  const { data } = await mcp(key, "tools/call", { name, arguments: args });
  const text = data.result.content[0].text;
  return { isError: !!data.result.isError, text, json: data.result.isError ? null : JSON.parse(text) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chiefKey, helperKey, chief, helper, orderId;

test("dashboard page is served with security headers", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /AI Agent Restaurant/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
});

test("owner login: wrong password refused, right one works", async () => {
  assert.equal((await api("state")).status, 401);
  assert.equal((await api("login", { method: "POST", body: { password: "nope" } })).status, 401);
  assert.equal((await api("login", { method: "POST", body: { password: PASSWORD } })).status, 200);
  assert.equal((await api("state")).status, 200);
});

test("hire a chief and a helper", async () => {
  const c = await api("staff", { method: "POST", body: { name: "Grok", vendor: "Grok", role: "chief" } });
  assert.equal(c.status, 200);
  assert.match(c.data.key, /^rk_/);
  assert.equal(c.data.staff.token_hash, undefined, "key hash must never leave the server");
  chiefKey = c.data.key;
  chief = c.data.staff;
  const h = await api("staff", { method: "POST", body: { name: "Claude", vendor: "Claude", role: "helper" } });
  helperKey = h.data.key;
  helper = h.data.staff;
  assert.equal((await api("staff", { method: "POST", body: { name: "claude" } })).status, 409, "names are unique");
});

test("MCP: bad key refused, initialize and tools/list work", async () => {
  assert.equal((await mcp("rk_wrong", "initialize", {})).status, 401);
  const init = await mcp(helperKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.data.result.protocolVersion, "2025-06-18");
  assert.match(init.data.result.instructions, /HELPER/);
  const notif = await fetch(`${BASE}/mcp/${helperKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notif.status, 202);
  const list = await mcp(helperKey, "tools/list", {});
  const names = list.data.result.tools.map((t) => t.name);
  for (const n of ["check_inbox", "claim_order", "update_order", "request_approval", "save_recipe"]) assert.ok(names.includes(n), n);
});

test("MCP: key can come as Bearer, bare Authorization or X-API-Key", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const h of [{ authorization: `Bearer ${helperKey}` }, { authorization: helperKey }, { "x-api-key": helperKey }]) {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h }, body });
    assert.equal(res.status, 200, JSON.stringify(Object.keys(h)));
  }
  const none = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "something-else" }, body });
  assert.equal(none.status, 401);
});

test("doorbell: link checked, rings are signed and delivered", async () => {
  const bad = await api(`staff/${helper.id}`, { method: "PATCH", body: { wake_url: "not a url" } });
  assert.equal(bad.status, 400);
  const ok = await api(`staff/${helper.id}`, { method: "PATCH", body: { wake_url: `http://localhost:${BELL_PORT}/wake`, wake_secret: "bell-secret" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.has_wake_secret, true);
  assert.equal(ok.data.wake_secret, undefined);
});

test("owner gives an order to the helper, which rings the helper's doorbell", async () => {
  const before = rings.length;
  const t = await api("tasks", { method: "POST", body: { title: "Compare three flight options", detail: "Tokyo, next month", assignee: "Claude" } });
  assert.equal(t.status, 200);
  orderId = t.data.id;
  for (let i = 0; i < 20 && rings.length === before; i++) await sleep(250);
  assert.equal(rings.length, before + 1, "doorbell should ring once");
  const ring = rings.at(-1);
  const body = JSON.parse(ring.body);
  assert.equal(body.staff, "Claude");
  assert.match(body.reason, /Compare three flight options/);
  const expected = "v1," + createHmac("sha256", "bell-secret").update(`${ring.headers["webhook-id"]}.${ring.headers["webhook-timestamp"]}.${ring.body}`).digest("base64");
  assert.equal(ring.headers["webhook-signature"], expected, "Standard Webhooks signature must verify");
});

test("helper works the order through MCP; only the owner can mark it done", async () => {
  const inbox = await tool(helperKey, "check_inbox");
  assert.equal(inbox.json.my_open_orders[0].id, orderId);
  const claimed = await tool(helperKey, "claim_order", { order_id: orderId });
  assert.equal(claimed.json.status, "doing");
  const stolen = await tool(chiefKey, "claim_order", { order_id: orderId });
  assert.ok(stolen.isError && /already taken by Claude/.test(stolen.text));
  const done = await tool(helperKey, "update_order", { order_id: orderId, status: "done" });
  assert.ok(done.isError && /Only the owner/.test(done.text));
  const review = await tool(helperKey, "update_order", { order_id: orderId, status: "review", note: "Option B is cheapest.", tokens_used: 9000 });
  assert.equal(review.json.status, "review");
  assert.equal(review.json.tokens_used, 9000);
  const owner = await api(`tasks/${orderId}`, { method: "PATCH", body: { status: "done" } });
  assert.equal(owner.data.status, "done");
});

test("helpers cannot hand orders to others; the chief can", async () => {
  const no = await tool(helperKey, "create_order", { title: "x", assignee: "Grok" });
  assert.ok(no.isError);
  const yes = await tool(chiefKey, "create_order", { title: "Fix the sign-in page", assignee: "Claude" });
  assert.equal(yes.isError, false);
});

test("quota battery and staff list", async () => {
  await tool(helperKey, "report_quota", { percent_left: 15, note: "resets 18:00" });
  const staff = await tool(chiefKey, "list_staff");
  const c = staff.json.find((s) => s.name === "Claude");
  assert.equal(c.quota_percent_left, 15);
  assert.equal((await tool(helperKey, "report_quota", { percent_left: 150 })).isError, true);
});

test("approvals: request, owner decides, staff sees the answer", async () => {
  const req = await tool(helperKey, "request_approval", { action: "Run npm install", reason: "Needed for the build" });
  const id = req.json.approval_id;
  const state = await api("state");
  assert.ok(state.data.approvals.some((a) => a.id === id && a.status === "pending"));
  await api(`approvals/${id}/decide`, { method: "POST", body: { approve: true, note: "ok" } });
  const ans = await tool(helperKey, "get_approval", { approval_id: id });
  assert.equal(ans.json.status, "approved");
});

test("recipe book is shared", async () => {
  await api("recipes", { method: "POST", body: { title: "House rules", body: "Never deploy on Fridays." } });
  const r = await tool(helperKey, "read_recipe", { recipe: "House rules" });
  assert.match(r.json.body, /Fridays/);
  await tool(chiefKey, "save_recipe", { title: "PR style", body: "Small PRs." });
  assert.equal((await tool(helperKey, "list_recipes")).json.length, 2);
});

test("team chat: chief @mention wakes the helper, helper mention does not loop", async () => {
  await sleep(1500); // let earlier rings finish
  let n = rings.length;
  await tool(chiefKey, "post_message", { body: "@Claude please look at order 2" });
  for (let i = 0; i < 20 && rings.length === n; i++) await sleep(250);
  assert.equal(rings.length, n + 1);
  const msgs = await tool(helperKey, "read_messages");
  assert.ok(msgs.json.some((m) => /please look at order 2/.test(m.body)));
});

test("generic webhook: needs the key, routes to the chief, de-duplicates", async () => {
  const src = await api("sources", { method: "POST", body: { name: "Herdr", kind: "generic" } });
  const url = `${BASE}/hook/${src.data.id}`;
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  const send = () =>
    fetch(`${url}?key=${encodeURIComponent(src.data.secret)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": "evt_1" },
      body: JSON.stringify({ summary: "Codex is waiting for approval" }),
    }).then((r) => r.json());
  assert.ok((await send()).event_id);
  assert.equal((await send()).duplicate, true);
  // Standard Webhooks signature instead of the key
  const body = JSON.stringify({ title: "Agent finished" });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from(src.data.secret.slice(6), "base64")).update(`evt_2.${ts}.${body}`).digest("base64");
  const signed = await fetch(url, { method: "POST", headers: { "webhook-id": "evt_2", "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` }, body });
  assert.equal(signed.status, 200);
  const inbox = await tool(chiefKey, "check_inbox");
  const summaries = inbox.json.notifications.map((e) => e.summary);
  assert.ok(summaries.includes("Codex is waiting for approval"));
  assert.ok(summaries.includes("Agent finished"));
  assert.equal((await tool(chiefKey, "check_inbox")).json.notifications.length, 0, "marked read");
});

test("GitHub webhook: signature checked", async () => {
  const src = await api("sources", { method: "POST", body: { name: "My GitHub", kind: "github", route_to: "Claude" } });
  const url = `${BASE}/hook/${src.data.id}`;
  const body = JSON.stringify({ action: "opened", number: 7, pull_request: { title: "Add login", html_url: "https://github.com/x/y/pull/7" }, repository: { full_name: "x/y" } });
  const headers = { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "d1" };
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "x-hub-signature-256": "sha256=bad" }, body })).status, 401);
  const sig = "sha256=" + createHmac("sha256", src.data.secret).update(body).digest("hex");
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "x-hub-signature-256": sig }, body })).status, 200);
  const inbox = await tool(helperKey, "check_inbox");
  assert.ok(inbox.json.notifications.some((e) => e.summary === "PR #7 opened: Add login (x/y)"));
});

test("Notion webhook: verification token, then signed events", async () => {
  const src = await api("sources", { method: "POST", body: { name: "Notion", kind: "notion" } });
  const url = `${BASE}/hook/${src.data.id}`;
  assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ type: "page.created" }) })).status, 401);
  await fetch(url, { method: "POST", body: JSON.stringify({ verification_token: "secret_abc" }) });
  const state = await api("state");
  assert.equal(state.data.sources.find((s) => s.id === src.data.id).notion_token, "secret_abc");
  const body = JSON.stringify({ id: "n1", type: "page.content_updated", entity: { type: "page", id: "p1" } });
  const sig = "sha256=" + createHmac("sha256", "secret_abc").update(body).digest("hex");
  assert.equal((await fetch(url, { method: "POST", headers: { "x-notion-signature": sig }, body })).status, 200);
});

test("Notion skills sync into the recipe book, one way", async () => {
  const state = await api("state");
  assert.equal(state.data.notion.configured, true);

  const first = await api("notion/sync", { method: "POST", body: {} });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.added, 2, "only Published pages are copied");

  // Staff read the synced skill through MCP, as Markdown
  const pr = await tool(chiefKey, "read_recipe", { recipe: "How we write PRs" });
  assert.match(pr.json.body, /## Rules/);
  assert.match(pr.json.body, /- Keep PRs small/);
  assert.match(pr.json.body, /```bash\nnpm test\n```/);
  assert.match(pr.json.body, /\| Move \| Use \|\n\| --- \| --- \|\n\| Pan \| Reveal a\\\|b \|/, "tables become Markdown tables");
  assert.equal(pr.json.origin, "notion");
  assert.equal((await tool(chiefKey, "read_recipe", { recipe: "Secret draft" })).isError, true, "unpublished stays out");

  // A dashboard recipe with the same title keeps its name; the Notion one gets a suffix
  assert.match((await tool(chiefKey, "read_recipe", { recipe: "House rules" })).json.body, /Fridays/);
  assert.match((await tool(chiefKey, "read_recipe", { recipe: "House rules (Notion)" })).json.body, /From Notion/);

  // Notion is the master copy: nobody can overwrite it from the restaurant
  const overwrite = await tool(chiefKey, "save_recipe", { title: "How we write PRs", body: "hacked" });
  assert.ok(overwrite.isError && /comes from Notion/.test(overwrite.text));
  const del = await api(`recipes/${pr.json.id}`, { method: "DELETE" });
  assert.equal(del.status, 409);

  // Nothing changed in Notion → no page bodies are downloaded again
  fakeNotion.calls.length = 0;
  const again = await api("notion/sync", { method: "POST", body: {} });
  assert.equal(again.data.unchanged, 2);
  assert.ok(!fakeNotion.calls.some((c) => c.includes("/blocks/")), "unchanged pages are skipped");

  // Edit one page, unpublish another
  fakeNotion.pages[0].edited = "2026-10-31T09:00:00.000Z";
  fakeNotion.pages[0].blocks = [["paragraph", "Updated rule"]];
  fakeNotion.pages[2].published = false;
  const third = await api("notion/sync", { method: "POST", body: {} });
  assert.equal(third.data.updated, 1);
  assert.equal(third.data.removed, 1);
  assert.match((await tool(chiefKey, "read_recipe", { recipe: "How we write PRs" })).json.body, /Updated rule/);
  assert.equal((await tool(chiefKey, "read_recipe", { recipe: "House rules (Notion)" })).isError, true);

  const after = await api("state");
  assert.equal(after.data.notion.last_error, null);
  assert.ok(after.data.notion.last_sync_at);
});

test("phone install files are served", async () => {
  const manifest = await (await fetch(BASE + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  assert.equal((await fetch(BASE + "/icon-512.png")).status, 200);
  assert.equal((await fetch(BASE + "/apple-touch-icon.png")).status, 200);
});

test("photos on orders: upload, checks, and AI staff can see them", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const up = (body, type) =>
    fetch(`${BASE}/api/tasks/${orderId}/attachments?name=menu.png`, { method: "POST", headers: { cookie, "content-type": type }, body });
  const ok = await up(png, "image/png");
  assert.equal(ok.status, 200);
  const { id } = await ok.json();
  assert.equal((await up(Buffer.from("hello"), "text/plain")).status, 415, "only photos");
  assert.equal((await up(Buffer.from("not really a png"), "image/png")).status, 415, "content must match the type");
  assert.equal((await fetch(`${BASE}/api/attachments/${id}`)).status, 401, "photos are private");

  const got = await fetch(`${BASE}/api/attachments/${id}`, { headers: { cookie } });
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

  const order = await tool(chiefKey, "get_order", { order_id: orderId });
  assert.equal(order.json.photos[0].photo_id, id);
  const { data } = await mcp(chiefKey, "tools/call", { name: "view_photo", arguments: { photo_id: id } });
  const image = data.result.content.find((c) => c.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, png.toString("base64"));

  assert.equal((await api(`attachments/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await tool(chiefKey, "view_photo", { photo_id: id })).isError, true);
});

test("AI staff can add photos: from a link or by sending the file", async () => {
  const bell = `http://localhost:${BELL_PORT}`;
  const linked = await tool(helperKey, "attach_photo", { order_id: orderId, url: `${bell}/img/moved` });
  assert.equal(linked.isError, false, linked.text);
  assert.equal(linked.json.name, "cha-chaan-teng.png", "follows the redirect and names the file");
  const page = await tool(helperKey, "attach_photo", { order_id: orderId, url: `${bell}/img/page` });
  assert.equal(page.isError, true, "web pages are not photos");

  const sent = await fetch(`${BASE}/mcp/${helperKey}/photos/${orderId}?name=render.png`, { method: "POST", body: TINY_PNG });
  assert.equal(sent.status, 200);
  const bad = await fetch(`${BASE}/mcp/rk_wrong/photos/${orderId}`, { method: "POST", body: TINY_PNG });
  assert.equal(bad.status, 401);

  const order = await tool(chiefKey, "get_order", { order_id: orderId });
  const names = order.json.photos.map((p) => p.name);
  assert.ok(names.includes("cha-chaan-teng.png") && names.includes("render.png"), names.join(","));
  for (const p of order.json.photos) await api(`attachments/${p.photo_id}`, { method: "DELETE" });
});

test("renaming staff keeps their key working", async () => {
  const r = await api(`staff/${chief.id}`, { method: "PATCH", body: { name: "Muse", vendor: "Meta Muse" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, "Muse");
  assert.equal(r.data.vendor, "Meta Muse");
  assert.equal((await tool(chiefKey, "check_inbox", { peek: true })).json.you.name, "Muse");
  assert.equal((await api(`staff/${chief.id}`, { method: "PATCH", body: { name: "claude" } })).status, 409, "taken names are refused");
  await api(`staff/${chief.id}`, { method: "PATCH", body: { name: "Grok", vendor: "Grok" } });
});

test("doorbell can send an Authorization header (e.g. Cursor Automations)", async () => {
  const r = await api(`staff/${helper.id}`, { method: "PATCH", body: { wake_auth: "Authorization: crsr_key123\n" } });
  assert.equal(r.data.has_wake_auth, true);
  assert.equal(r.data.wake_auth, undefined, "the key never goes back to the browser");
  await sleep(500);
  const n = rings.length;
  assert.equal((await api(`staff/${helper.id}/ring`, { method: "POST", body: {} })).status, 200);
  for (let i = 0; i < 20 && rings.length === n; i++) await sleep(250);
  assert.equal(rings.at(-1).headers.authorization, "Bearer crsr_key123");
  const state = await api("state");
  assert.ok(!JSON.stringify(state.data).includes("crsr_key123"));
});

test("daily check rings only staff with something new, like a helper's @mention", async () => {
  await tool(helperKey, "check_inbox");
  const quiet = await api("daily-check", { method: "POST", body: {} });
  assert.equal(quiet.status, 200);
  assert.ok(!quiet.data.rang.some((r) => r.name === helper.name), "nothing new, so no ring");
  // Helpers can't wake each other with @mentions, so the daily check is what picks this up.
  const temp = await api("staff", { method: "POST", body: { name: "Temp", role: "helper" } });
  await sleep(500);
  const n = rings.length;
  await tool(temp.data.key, "post_message", { body: `@${helper.name} can you look at this?` });
  await sleep(500);
  assert.equal(rings.length, n, "a helper's @mention doesn't ring by itself");
  const busy = await api("daily-check", { method: "POST", body: {} });
  assert.match(busy.data.rang.find((r) => r.name === helper.name)?.reason ?? "", /1 @mention/);
  for (let i = 0; i < 20 && rings.length === n; i++) await sleep(250);
  assert.equal(rings.length, n + 1);
  await tool(helperKey, "check_inbox");
  const after = await api("daily-check", { method: "POST", body: {} });
  assert.ok(!after.data.rang.some((r) => r.name === helper.name), "once checked in, no more rings");
  const state = await api("state");
  assert.ok(state.data.daily_check.next_at > Date.now(), "next daily check is scheduled");
  assert.equal(state.data.daily_check.last.rang.length, after.data.rang.length);
  await api(`staff/${temp.data.staff.id}`, { method: "DELETE" });
});

test("letting staff go revokes their key and frees their orders", async () => {
  await api(`staff/${helper.id}`, { method: "DELETE" });
  assert.equal((await mcp(helperKey, "tools/list", {})).status, 401);
  const state = await api("state");
  assert.ok(state.data.tasks.filter((t) => t.status !== "done").every((t) => t.assignee_id !== helper.id));
});

test("cross-site requests and sign-out", async () => {
  const res = await fetch(BASE + "/api/tasks", { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
  assert.equal(res.status, 403);
  assert.equal((await api("state")).data.wrong_passwords_24h, 1, "the owner sees wrong password tries");
  await api("logout", { method: "POST" });
  assert.equal((await api("state")).status, 401);
});

test("wrong passwords: 5 in 15 minutes pauses sign-in", async () => {
  // One wrong try already happened in the login test.
  for (let i = 0; i < 4; i++) assert.equal((await api("login", { method: "POST", body: { password: "guess" + i } })).status, 401);
  const locked = await api("login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(locked.status, 429, "even the right password waits while paused");
  assert.match(locked.data.error, /Wait 15 minutes/);
});
