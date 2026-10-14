/**
 * Copy the report view template next to the compiled server (dist/widget/report.html).
 * tsc compiles src/widget/view.ts but does not copy HTML. The ext-apps client is inlined when the
 * server first serves the view, from the installed package, so the template stays small here.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../src/widget/report.html", import.meta.url));
const to = fileURLToPath(new URL("../dist/widget/report.html", import.meta.url));
mkdirSync(fileURLToPath(new URL("../dist/widget/", import.meta.url)), { recursive: true });
copyFileSync(from, to);
console.log("report view template copied to dist/widget/report.html");
