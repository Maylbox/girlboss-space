import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await build({
  entryPoints: ["src/client/index.ts"],
  outfile: "dist/assets/blackjack.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
});
console.log("Built static pages and Blackjack client.");
