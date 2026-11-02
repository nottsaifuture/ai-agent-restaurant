// Reads the owner's Notion "Skills" database so skills can be copied (one way)
// into the restaurant's recipe book. Notion stays the master copy.

const NOTION_VERSION = "2026-03-11";
const MAX_DEPTH = 2; // how deep nested blocks (toggles, sub-lists) are read

export interface NotionSkill {
  pageId: string;
  title: string;
  url: string;
  edited: string;
}

export class NotionRateLimited extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Notion asked us to slow down. Retrying in ${retryAfterSeconds}s.`);
  }
}

/** Thrown when one sync run has used up its request budget; the rest continues in the next run. */
export class NotionBudgetSpent extends Error {}

type Json = Record<string, any>;

export class NotionClient {
  private calls = 0;

  constructor(
    private token: string,
    private base = "https://api.notion.com",
    // Workers on the free plan may make 50 outgoing requests per run; stay well under.
    private budget = 40,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<Json> {
    if (++this.calls > this.budget) throw new NotionBudgetSpent();
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "notion-version": NOTION_VERSION,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) throw new NotionRateLimited(Number(res.headers.get("retry-after")) || 30);
    const data = (await res.json().catch(() => ({}))) as Json;
    if (res.status === 401) throw new Error("Notion rejected the key. Check NOTION_TOKEN.");
    if (res.status === 404) {
      throw Object.assign(new Error("Notion can't find the Skills database. Share it with your integration: open it in Notion → ••• → Connections → add your integration."), { status: 404 });
    }
    if (!res.ok) throw new Error(`Notion error ${res.status}: ${data.message ?? "unknown"}`);
    return data;
  }

  /** Lists skill pages. If the database has a "Published" checkbox, only ticked pages count. */
  async listSkills(databaseId: string): Promise<NotionSkill[]> {
    const id = databaseId.replace(/-/g, "");
    let dataSourceId = id;
    try {
      const db = await this.req("GET", `/v1/databases/${id}`);
      dataSourceId = db.data_sources?.[0]?.id ?? id;
    } catch (e) {
      // The ID may already be a data source ID rather than a database ID.
      if ((e as { status?: number }).status !== 404) throw e;
    }
    const skills: NotionSkill[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await this.req("POST", `/v1/data_sources/${dataSourceId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const p of res.results ?? []) {
        if (p.object !== "page" || p.in_trash) continue;
        const props: Json = p.properties ?? {};
        const published = Object.entries(props).find(([name, v]) => name.toLowerCase() === "published" && (v as Json).type === "checkbox");
        if (published && !(published[1] as Json).checkbox) continue;
        const titleProp = Object.values(props).find((v) => (v as Json).type === "title") as Json | undefined;
        const title = richText(titleProp?.title ?? [], false).trim();
        if (!title) continue;
        skills.push({ pageId: p.id, title, url: p.url ?? "", edited: p.last_edited_time ?? "" });
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return skills;
  }

  /** Reads a page's content as Markdown. */
  async pageMarkdown(pageId: string): Promise<string> {
    return (await this.blocks(pageId, 0)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private async blocks(blockId: string, depth: number): Promise<string[]> {
    const lines: string[] = [];
    let cursor: string | undefined;
    let numbered = 0;
    do {
      const res = await this.req("GET", `/v1/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      for (const b of res.results ?? []) {
        numbered = b.type === "numbered_list_item" ? numbered + 1 : 0;
        if (b.type === "table") {
          lines.push("", ...(await this.table(b.id)), "");
          continue;
        }
        const line = blockLine(b, numbered);
        if (line != null) lines.push(line);
        if (b.has_children && depth < MAX_DEPTH && b.type !== "child_page" && b.type !== "child_database") {
          const kids = await this.blocks(b.id, depth + 1);
          lines.push(...kids.map((k) => (k ? "  " + k : k)));
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return lines;
  }

  /** A Notion table becomes a Markdown table; its rows are the table block's children. */
  private async table(tableId: string): Promise<string[]> {
    const rows: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.req("GET", `/v1/blocks/${tableId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      for (const r of res.results ?? []) {
        if (r.type !== "table_row") continue;
        const cells: Json[][] = r.table_row?.cells ?? [];
        rows.push(`| ${cells.map((c) => richText(c).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
        if (rows.length === 1) rows.push(`| ${cells.map(() => "---").join(" | ")} |`);
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return rows;
  }
}

function richText(parts: Json[], markdown = true): string {
  return parts
    .map((t) => {
      let s: string = t.plain_text ?? "";
      if (!markdown || !s) return s;
      if (t.annotations?.code) s = "`" + s + "`";
      else if (t.annotations?.bold) s = `**${s}**`;
      else if (t.annotations?.italic) s = `_${s}_`;
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join("");
}

function blockLine(b: Json, numbered: number): string | null {
  const v: Json = b[b.type] ?? {};
  const text = richText(v.rich_text ?? []);
  switch (b.type) {
    case "paragraph":
      return text ? text + "\n" : "";
    case "heading_1":
      return `\n# ${text}\n`;
    case "heading_2":
      return `\n## ${text}\n`;
    case "heading_3":
    case "heading_4":
      return `\n### ${text}\n`;
    case "bulleted_list_item":
    case "toggle":
      return `- ${text}`;
    case "numbered_list_item":
      return `${numbered}. ${text}`;
    case "to_do":
      return `- [${v.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}\n`;
    case "callout":
      return `> ${v.icon?.emoji ? v.icon.emoji + " " : ""}${text}\n`;
    case "code":
      return "```" + (v.language && v.language !== "plain text" ? v.language : "") + "\n" + richText(v.rich_text ?? [], false) + "\n```\n";
    case "divider":
      return "---";
    case "equation":
      return `$$${v.expression ?? ""}$$`;
    case "child_page":
      return `(Sub-page: ${v.title ?? ""})`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return v.url ? `<${v.url}>` : null;
    case "image":
    case "file":
    case "pdf":
    case "video":
      return `(${b.type}${v.caption?.length ? ": " + richText(v.caption, false) : ""})`;
    default:
      return null;
  }
}
