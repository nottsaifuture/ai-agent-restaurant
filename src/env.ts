import type { Restaurant } from "./restaurant";

export interface Env {
  RESTAURANT: DurableObjectNamespace<Restaurant>;
  ASSETS: Fetcher;
  /** Password for the owner dashboard. Set with `wrangler secret put OWNER_PASSWORD`. */
  OWNER_PASSWORD?: string;
  RESTAURANT_NAME?: string;
  /** "true" lets doorbells ring http:// and local addresses. Local testing only. */
  ALLOW_LOCAL_WAKE?: string;
  /** Notion integration secret, for syncing skills. Set with `wrangler secret put NOTION_TOKEN`. */
  NOTION_TOKEN?: string;
  /** ID of the Notion "Skills" database (from its URL). */
  NOTION_SKILLS_DB?: string;
  /** Override the Notion API address. Tests only. */
  NOTION_API_BASE?: string;
}
