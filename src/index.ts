import type { Env } from "./env";

export { Restaurant } from "./restaurant";

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (/^\/(api|mcp|hook)(\/|$)/.test(pathname)) {
      // The whole restaurant lives in one Durable Object.
      const stub = env.RESTAURANT.get(env.RESTAURANT.idFromName("main"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
