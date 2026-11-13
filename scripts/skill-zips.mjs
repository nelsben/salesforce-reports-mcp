// Builds one uploadable zip per skill, so a person can add a skill to Claude
// Desktop or claude.ai. Each zip's root is the skill folder (<name>/SKILL.md).
// Usage: node scripts/skill-zips.mjs [outputFolder] [ref]
// Defaults: outputFolder skill-zips, ref HEAD.
// It uses `git archive`, so it archives committed files at <ref>, default HEAD:
// uncommitted edits to skills/ are not in the zips.
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = ["report-runner", "report-designer", "report-deploy"];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? "skill-zips");
const ref = process.argv[3] ?? "HEAD";

try {
  mkdirSync(out, { recursive: true });
  for (const name of NAMES) {
    const file = join(out, `${name}.zip`);
    execFileSync(
      "git",
      ["-C", repo, "archive", "--format=zip", `--prefix=${name}/`, "-o", file, `${ref}:skills/${name}`],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    console.log(`${name}.zip ${statSync(file).size}`);
  }
} catch (err) {
  console.error(`skill-zips failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
