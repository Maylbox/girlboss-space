import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";

export async function runtime(
  port = 0,
  inspection = false,
): Promise<Miniflare> {
  const source = inspection
    ? `
    import worker, { BlackjackRoom } from ${JSON.stringify(resolve("src/worker/index.ts"))};
    export default worker;
    export class TestRoom extends BlackjackRoom {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/__test/inspect') return Response.json(await this.ctx.storage.get('room') ?? null);
        if (path === '/__test/edit') {
          const r = await this.ctx.storage.get('room');
          const change = await request.json();
          if (change.expire) r.lastActivity = Date.now() - 86400001;
          if (change.timeout) r.turnDeadline = Date.now() - 1;
          if (change.shoe) r.game.shoe = change.shoe;
          if (change.disconnect) {
            const p = r.game.players.find(p => p.id === change.disconnect);
            p.disconnectedAt = Date.now() - 90001;
            r.members[p.id].expiresAt = Date.now() - 1;
          }
          await this.ctx.storage.put('room', r);
          return new Response('ok');
        }
        if (path === '/__test/alarm') { await super.alarm(); return new Response('ok'); }
        return super.fetch(request);
      }
    }`
    : `export { default, BlackjackRoom } from ${JSON.stringify(resolve("src/worker/index.ts"))};`;
  const result = await build({
    stdin: {
      contents: source,
      resolveDir: process.cwd(),
      sourcefile: "test-worker.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "girlboss-test",
      script: result.outputFiles[0].text,
      modules: true,
      compatibilityDate: "2026-09-30",
      host: "127.0.0.1",
      port,
      durableObjects: {
        ROOMS: {
          className: inspection ? "TestRoom" : "BlackjackRoom",
          useSQLite: true,
        },
      },
      assets: {
        directory: resolve("dist"),
        binding: "ASSETS",
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: { html_handling: "none" },
      },
    }),
  );
  await mf.ready;
  return mf;
}
