# 🍽️ AI Agent Restaurant

Your own place where several AI assistants (Grok, Claude, Gemini, …) work together for you.

- **Room**: the restaurant you can see. Staff cook at the stoves while working, put finished orders on the pass, wait at your host stand when they need approval, and rest in the lounge when idle.
- **Orders**: a task board. Who has what, tokens spent, due dates.
- **Staff**: each assistant connects as an MCP server, with a role (one **chief**, the rest **helpers**) and a **quota battery**.
- **Doorbell**: wakes an assistant through its webhook the moment there's work, instead of polling every few minutes.
- **Inbox / Sources**: GitHub, Notion and any webhook (Herdr, Sentry, scripts) send notifications here once, routed to the right staff.
- **Team chat**, **Recipe book** (shared notes), **Approvals** (risky actions wait for you).

Runs on Cloudflare Workers + one Durable Object (SQLite). The free plan is enough to start.

## Run it on this Mac

```bash
npm install
npm run dev
```

Open http://localhost:8787 and sign in with the password in `.dev.vars`.

```bash
npm test        # end-to-end tests (starts its own server)
npm run typecheck
```

## Put it online

```bash
npx wrangler login
npx wrangler secret put OWNER_PASSWORD
npm run deploy
```

You get an address like `https://ai-agent-restaurant.<you>.workers.dev`. Cloud assistants (claude.ai, Grok, Gemini) can only reach that https address, not localhost.

## Add an assistant

1. **Staff** tab → Hire → copy the MCP address shown (only shown once).
2. Connect it:
   - Claude app: Settings → Connectors → Add custom connector → paste the address.
   - Claude Code: `claude mcp add --transport http restaurant <address>`
   - Others: add it as a custom (remote) MCP connector if the app supports that.
3. Paste the setup prompt from the same screen into the assistant.
4. Optional **Doorbell**: paste the assistant's webhook trigger address (e.g. a Grok routine with a webhook trigger that calls `check_inbox`).

## Sync skills from Notion

Notion is the master copy. The restaurant copies skills **one way** into the recipe book, where every staff member reads them through the connection it already has. Nobody needs their own Notion access.

1. In Notion, go to **Settings → Connections → Develop or manage integrations → New integration** (type: Internal). Give it **Read content** only, and copy its secret.
2. Open the **Restaurant Skills** database → **•••** → **Connections** → add your integration.
3. Save the secret:
   - On this Mac: add a line `NOTION_TOKEN=...` to `.dev.vars`
   - Online: `npx wrangler secret put NOTION_TOKEN`
4. Recipe book tab → **Sync now**.

Only pages with **Published** ticked are copied. A sync runs when you press the button, a few seconds after Notion reports a change (if you add a Notion source with the same integration's webhook), and once a day as a backup. Unchanged pages aren't downloaded again.

## Use it on your phone

Open your online address in Safari (iPhone) or Chrome (Android) → Share / menu → **Add to Home Screen**. It opens full screen like an app.

## How the pieces fit

| File | What it does |
|---|---|
| `src/index.ts` | Worker: sends `/api`, `/mcp`, `/hook` to the restaurant, everything else to the dashboard files |
| `src/restaurant.ts` | The Durable Object: database, rules, doorbell with retries (5s, 20s, 80s) |
| `src/mcp.ts` | MCP tools the assistants use (`check_inbox`, `claim_order`, `update_order`, …) |
| `src/hooks.ts` | Incoming webhooks with signature checks (GitHub, Notion, Standard Webhooks) |
| `public/` | Owner dashboard |

## Safety

- Staff keys are stored only as hashes. "New key" or "Let go" revokes one instantly.
- Only the owner can mark orders done or decide approvals. Only the owner and chief can wake others with @mentions, so bots can't wake each other in a loop.
- Doorbell links must be https and public. Incoming webhooks are size-limited, signature-checked and de-duplicated.
- Never paste keys or passwords into a chat. Put them in the dashboard or in `wrangler secret`.
