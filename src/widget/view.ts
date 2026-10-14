import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** The report view: one MCP App resource that draws a ReportResult from run_report or query_report. */
export const REPORT_VIEW_URI = "ui://salesforce-reports/report";

const BUNDLE_MARKER = "/*@ext-apps-bundle*/";

let cached: string | undefined;

/**
 * The view as one self-contained HTML document: the template (inline CSS and view script) with the
 * ext-apps browser client inlined, so the host needs no network and no csp allowlist.
 * When a file is missing it returns a small document that says so; the server keeps running.
 */
export function reportViewHtml(): string {
  if (cached) return cached;
  try {
    const template = readFileSync(new URL("./report.html", import.meta.url), "utf8");
    const bundlePath = createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps");
    const bundle = inlineBundle(readFileSync(bundlePath, "utf8"));
    if (!template.includes(BUNDLE_MARKER)) throw new Error("The view template has no place for the ext-apps client.");
    cached = template.replace(BUNDLE_MARKER, () => bundle);
    return cached;
  } catch (error) {
    return missingView(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Turn the ext-apps ES module bundle into a script that defines `const ExtApps = {...}`.
 * The bundle runs inside a function, so its minified names cannot clash with the view's.
 */
export function inlineBundle(bundle: string): string {
  const match = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(bundle);
  if (!match) throw new Error("The ext-apps client bundle has an unexpected shape (no trailing export list).");
  const entries = match[1]!
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [local, exported = local] = part.split(/\s+as\s+/);
      return `${JSON.stringify(exported)}:${local}`;
    });
  const body = bundle.slice(0, match.index).replace(/<\/script/gi, "<\\/script");
  return `const ExtApps = (() => {\n${body}\nreturn {${entries.join(",")}};\n})();`;
}

function missingView(reason: string): string {
  const safe = reason.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report view unavailable</title></head><body><p>The report view is not available in this install: ${safe} The text result is unchanged.</p></body></html>`;
}
