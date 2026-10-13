import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CALLOUT_NAME,
  CERTIFICATE_NAMES,
  certificateMeta,
  certificateRemoval,
  FILES,
  fillCertificate,
  fillCredential,
  fillSigningCertificate,
  myDomainOf,
  PLACEHOLDERS,
  publicCertificate,
  renewalHops,
  setupCertificate,
  unfilled,
} from "../salesforce/scripts/callout-app.js";

// The setup fills a temp copy of callout-app (docs/decisions/0012). These are neutral values, not an org's.
const values = { myDomain: "example.my.salesforce.com", consumerKey: "KEY_example_123", audience: "https://example.my.salesforce.com" };

describe("callout-app setup values", () => {
  it("reads My Domain from an https instance URL and refuses anything else", () => {
    expect(myDomainOf("https://example.my.salesforce.com")).toBe("example.my.salesforce.com");
    expect(myDomainOf("https://example.my.salesforce.com/")).toBe("example.my.salesforce.com");
    expect(() => myDomainOf("http://example.my.salesforce.com")).toThrow();
    expect(() => myDomainOf("https://example.my.salesforce.com/path")).toThrow();
  });

  it("fills iss and sub unquoted and keeps aud quoted, as the tracked file writes them", () => {
    const xml = [
      `<parameterValue>https://${PLACEHOLDERS.myDomain}/services/oauth2/token</parameterValue>`,
      `<parameterValue>${PLACEHOLDERS.consumerKey}</parameterValue>`,
      `<parameterValue>&quot;${PLACEHOLDERS.audience}&quot;</parameterValue>`,
      "<parameterValue>{!$User.Username}</parameterValue>",
    ].join("\n");
    const filled = fillCredential(xml, values);
    expect(filled).toContain("<parameterValue>https://example.my.salesforce.com/services/oauth2/token</parameterValue>");
    expect(filled).toContain("<parameterValue>KEY_example_123</parameterValue>");
    expect(filled).toContain("<parameterValue>&quot;https://example.my.salesforce.com&quot;</parameterValue>");
    expect(filled).toContain("<parameterValue>{!$User.Username}</parameterValue>");
    expect(unfilled(filled)).toEqual([]);
  });

  it("refuses an empty value or one XML would need escaped", () => {
    expect(() => fillCredential("x", { ...values, consumerKey: "" })).toThrow(/consumerKey/);
    expect(() => fillCredential("x", { ...values, myDomain: "a<b" })).toThrow(/myDomain/);
  });

  it("takes one public PEM certificate, and refuses a private key or anything else", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    expect(publicCertificate(pem)).toBe(pem.trim());
    expect(fillCertificate(`<certificate>${PLACEHOLDERS.certificate}</certificate>`, publicCertificate(pem))).toBe(`<certificate>${pem.trim()}</certificate>`);
    expect(() => publicCertificate("")).toThrow();
    expect(() => publicCertificate("-----BEGIN CERTIFICATE-----\nPRIVATE KEY\n-----END CERTIFICATE-----")).toThrow(/private key/);
  });

  it("names any placeholder left", () => {
    expect(unfilled(`${PLACEHOLDERS.certificate} ${PLACEHOLDERS.audience}`)).toEqual([PLACEHOLDERS.certificate, PLACEHOLDERS.audience]);
  });
});

describe("callout-app certificate renewal", () => {
  const second = `${CALLOUT_NAME}2`;
  const tracked = (file: string) => readFileSync(`salesforce/callout-app/main/default/${file}`, "utf8");

  it("has two names, the first being the one the tracked files use", () => {
    expect(CERTIFICATE_NAMES).toEqual([CALLOUT_NAME, second]);
  });

  const at = (name: string, created: string) => ({ name, created: `${created}T00:00:00.000+0000` });

  it("setup makes the certificate in an org without one, keeps the one it finds, and ignores certificates not ours", () => {
    expect(setupCertificate([])).toEqual({ make: true, use: CALLOUT_NAME, remove: [] });
    expect(setupCertificate([at(CALLOUT_NAME, "2026-10-12")])).toEqual({ make: false, use: CALLOUT_NAME, remove: [] });
    expect(setupCertificate([at("SomeoneElses", "2026-10-12")])).toEqual({ make: true, use: CALLOUT_NAME, remove: [] });
  });

  it("setup stops when a renewal stopped part way, and says how to finish it", () => {
    expect(() => setupCertificate([at(second, "2026-10-12")])).toThrow(/callout:renew/);
    expect(() => setupCertificate([at(CALLOUT_NAME, "2026-10-12"), at(second, "2027-09-01")])).toThrow(/callout:renew/);
  });

  it("renewal goes through the second name and back, so a new certificate ends under the first", () => {
    expect(renewalHops([at(CALLOUT_NAME, "2026-10-12")])).toEqual([
      { make: true, use: second, remove: [CALLOUT_NAME] },
      { make: true, use: CALLOUT_NAME, remove: [second] },
    ]);
  });

  it("finishes a renewal that stopped part way, from wherever it stopped, and never makes a third certificate", () => {
    // Stopped after the first switch: only the second name is left.
    expect(renewalHops([at(second, "2027-09-01")])).toEqual([{ make: true, use: CALLOUT_NAME, remove: [second] }]);
    // Stopped in the first switch: the second name is the newer.
    expect(renewalHops([at(CALLOUT_NAME, "2026-10-12"), at(second, "2027-09-01")])).toEqual([
      { make: false, use: second, remove: [CALLOUT_NAME] },
      { make: true, use: CALLOUT_NAME, remove: [second] },
    ]);
    // Stopped in the second switch: the first name is the newer.
    expect(renewalHops([at(second, "2027-09-01"), at(CALLOUT_NAME, "2027-09-02")])).toEqual([{ make: false, use: CALLOUT_NAME, remove: [second] }]);
  });

  it("refuses to renew in an org without callout-app, and ignores certificates that are not ours", () => {
    expect(() => renewalHops([])).toThrow(/callout:setup/);
    expect(() => renewalHops([at("SomeoneElses", "2026-10-12")])).toThrow(/callout:setup/);
    expect(renewalHops([at(CALLOUT_NAME, "2026-10-12"), at("SomeoneElses", "2027-01-01")])).toHaveLength(2);
  });

  it("renames the tracked certificate's label", () => {
    const meta = certificateMeta(tracked(`${FILES.certificate}-meta.xml`), second);
    expect(meta).toContain(`<masterLabel>${second}</masterLabel>`);
    expect(meta).toContain("<privateKeyExportable>false</privateKeyExportable>");
    expect(() => certificateMeta("<Certificate/>", second)).toThrow();
  });

  it("points the tracked external credential's signing certificate at either name, and no other", () => {
    const xml = tracked(FILES.externalCredential);
    expect(fillSigningCertificate(xml, second)).toContain(`<certificate>${second}</certificate>`);
    expect(fillSigningCertificate(xml, second)).not.toContain(`<certificate>${CALLOUT_NAME}</certificate>`);
    expect(fillSigningCertificate(xml, CALLOUT_NAME)).toBe(xml);
    expect(() => fillSigningCertificate(xml, "SomeoneElses")).toThrow();
    expect(() => fillSigningCertificate("<x/>", second)).toThrow(/signing certificate/);
  });

  it("builds a removal of our certificates only", () => {
    const xml = certificateRemoval([CALLOUT_NAME], "68.0");
    expect(xml).toContain(`<members>${CALLOUT_NAME}</members>`);
    expect(xml).toContain("<name>Certificate</name>");
    expect(xml).toContain("<version>68.0</version>");
    expect(xml).not.toContain(second);
    expect(() => certificateRemoval([], "68.0")).toThrow();
    expect(() => certificateRemoval(["SomeoneElses"], "68.0")).toThrow();
  });

  it("the removal manifest names the first certificate name, where every renewal ends", () => {
    const manifest = readFileSync("salesforce/manifest/callout-app/destructiveChanges.xml", "utf8");
    expect(manifest).toContain(`<members>${CALLOUT_NAME}</members>`);
    expect(manifest).not.toContain(`<members>${second}</members>`);
  });
});
