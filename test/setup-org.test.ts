import { describe, expect, it } from "vitest";
import { checkOrg } from "../salesforce/scripts/org.js";

describe("checkOrg", () => {
  const env = (list?: string) => (list === undefined ? {} : { SF_REPORTS_SETUP_ORGS: list });

  it("allows an alias on the list", () => {
    expect(checkOrg("a", { env: env("a,b"), yes: false })).toEqual({ ok: true });
  });
  it("refuses an alias off the list, with and without --yes", () => {
    for (const yes of [false, true]) {
      const r = checkOrg("c", { env: env("a,b"), yes });
      expect(r.ok).toBe(false);
    }
  });
  it("with no list, refuses unless --yes", () => {
    const r = checkOrg("a", { env: env(), yes: false });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ message: expect.stringContaining("--yes") });
    expect(r).toMatchObject({ message: expect.stringContaining("SF_REPORTS_SETUP_ORGS") });
    expect(checkOrg("a", { env: env(), yes: true })).toEqual({ ok: true });
  });
  it("treats an empty list as unset", () => {
    expect(checkOrg("a", { env: env(" , ,"), yes: false }).ok).toBe(false);
    expect(checkOrg("a", { env: env(""), yes: true }).ok).toBe(true);
  });
  it("trims spaces and ignores empty entries", () => {
    expect(checkOrg("b", { env: env(" a , ,b ,, "), yes: false }).ok).toBe(true);
    expect(checkOrg("", { env: env("a,,b"), yes: false }).ok).toBe(false);
  });
});
