import { describe, expect, it } from "vitest";
import { fillCertificate, fillCredential, myDomainOf, PLACEHOLDERS, publicCertificate, unfilled } from "../salesforce/scripts/callout-app.js";

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
