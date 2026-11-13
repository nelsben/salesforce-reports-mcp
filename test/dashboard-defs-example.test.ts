import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDefs } from "../src/dashboard-files.js";

const examplePath = fileURLToPath(new URL("../skills/report-runner/dashboard-defs.example.json", import.meta.url));

describe("dashboard-defs.example.json", () => {
  it("is a valid defs file with two Opportunity pipeline reports over every close date", () => {
    const defs = JSON.parse(readFileSync(examplePath, "utf8")) as unknown;
    const checked = validateDefs(defs);
    if ("error" in checked) throw new Error(checked.error);

    expect(checked.entries.map(([id]) => id)).toEqual(["pipeline-by-stage", "pipeline-by-owner"]);
    for (const [, args] of checked.entries) {
      expect(args.reportType).toBe("Opportunity");
      const dateFilter = args.dateFilter as Record<string, unknown>;
      expect(dateFilter.duration).toBe("CUSTOM");
      expect(dateFilter).not.toHaveProperty("startDate");
      expect(dateFilter).not.toHaveProperty("endDate");
    }
  });
});
