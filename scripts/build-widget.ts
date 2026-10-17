/**
 * Copy the view templates next to the compiled server (dist/widget/report.html and dist/widget/dashboard.html).
 * tsc compiles src/widget/view.ts but does not copy HTML. The ext-apps client is inlined when the
 * server first serves a view, from the installed package, so the templates stay small here.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

mkdirSync(fileURLToPath(new URL("../dist/widget/", import.meta.url)), { recursive: true });
for (const file of ["report.html", "dashboard.html"]) {
  const from = fileURLToPath(new URL(`../src/widget/${file}`, import.meta.url));
  const to = fileURLToPath(new URL(`../dist/widget/${file}`, import.meta.url));
  copyFileSync(from, to);
  console.log(`view template copied to dist/widget/${file}`);
}
