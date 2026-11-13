import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const names = ["report-runner", "report-designer", "report-deploy"];
const script = join(process.cwd(), "scripts", "skill-zips.mjs");
const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

describe("skill-zips script", () => {
  const out = join(mkdtempSync(join(tmpdir(), "skill-zips-")), "out");
  const stdout = execFileSync("node", [script, out], { encoding: "utf8" });

  it("writes one zip per skill and prints a line for each", () => {
    for (const n of names) {
      expect(existsSync(join(out, `${n}.zip`))).toBe(true);
      expect(statSync(join(out, `${n}.zip`)).size).toBeGreaterThan(0);
      expect(stdout).toMatch(new RegExp(`^${n}\\.zip \\d+$`, "m"));
    }
  });

  it.skipIf(!hasUnzip)("roots each zip at its skill folder", () => {
    for (const n of names) {
      const entries = execFileSync("unzip", ["-Z1", join(out, `${n}.zip`)], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
      expect(entries).toContain(`${n}/SKILL.md`);
      expect(entries.filter((e) => !e.startsWith(`${n}/`))).toEqual([]);
    }
  });
});
