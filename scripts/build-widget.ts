/**
 * Build the view templates next to the compiled server (dist/widget/report.html and dist/widget/dashboard.html).
 * tsc compiles src/widget/view.ts but does not copy HTML. Each template gets src/widget/tokens.css, the vendored
 * SLDS token values, inlined in place of its tokens marker (decision 0018). The ext-apps client is inlined when the
 * server first serves a view, from the installed package, so the templates stay small here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inlineTokens } from "../src/widget/view.js";

const src = (file: string) => fileURLToPath(new URL(`../src/widget/${file}`, import.meta.url));
const tokens = readFileSync(src("tokens.css"), "utf8");
mkdirSync(fileURLToPath(new URL("../dist/widget/", import.meta.url)), { recursive: true });
for (const file of ["report.html", "dashboard.html"]) {
  const to = fileURLToPath(new URL(`../dist/widget/${file}`, import.meta.url));
  writeFileSync(to, inlineTokens(readFileSync(src(file), "utf8"), tokens));
  console.log(`view template built to dist/widget/${file}, with the SLDS tokens`);
}
