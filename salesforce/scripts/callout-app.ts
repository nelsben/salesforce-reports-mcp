/**
 * The callout-app package: its component names, the placeholders its tracked files hold, and how the setup fills them.
 * The tracked files hold placeholders only. salesforce/scripts/callout-setup.ts fills a temp copy at deploy time, so no
 * My Domain, consumer key or certificate reaches the repo (docs/decisions/0012).
 */

/** Every component in the package is named this, but the permission set. */
export const CALLOUT_NAME = "SalesforceReportsCallout";
export const CALLOUT_PERMISSION_SET = "Salesforce_Reports_Callout";

/** The placeholders, and the files under callout-app/main/default that hold them. */
export const PLACEHOLDERS = {
  certificate: "__CERTIFICATE__",
  myDomain: "__MY_DOMAIN__",
  consumerKey: "__CONSUMER_KEY__",
  audience: "__AUDIENCE__",
} as const;

export const FILES = {
  certificate: `certs/${CALLOUT_NAME}.crt`,
  globalOauth: `extlClntAppGlobalOauthSets/${CALLOUT_NAME}.ecaGlblOauth-meta.xml`,
  externalCredential: `externalCredentials/${CALLOUT_NAME}.externalCredential-meta.xml`,
  namedCredential: `namedCredentials/${CALLOUT_NAME}.namedCredential-meta.xml`,
} as const;

/**
 * The deploy steps, in order, as folders under callout-app/main/default. The certificate goes first so the org makes
 * the key pair. The app goes before the credential, which needs its consumer key. The app's OAuth policy names the
 * permission set, so it goes last.
 */
export const STEPS = {
  certificate: ["certs"],
  app: ["externalClientApps", "extlClntAppOauthSettings", "extlClntAppGlobalOauthSets", "extlClntAppPolicies"],
  credential: ["externalCredentials", "namedCredentials", "permissionsets"],
  policy: ["extlClntAppOauthPolicies"],
} as const;

/**
 * What a renewal deploys once the new certificate is in the org: the app's global OAuth settings (the public part the
 * app checks) and the external credential (the certificate it signs with). One deploy, so the two switch together.
 */
export const RENEWAL = ["extlClntAppGlobalOauthSets", "externalCredentials"] as const;

/** The My Domain host of an instance URL: no scheme, no trailing slash. Throws on anything else. */
export function myDomainOf(instanceUrl: string): string {
  const match = /^https:\/\/([a-z0-9.-]+)\/?$/i.exec(instanceUrl.trim());
  if (!match) throw new Error("The org's instance URL is not an https host, so My Domain cannot be read from it.");
  return match[1];
}

/** The public certificate as the app's global OAuth settings take it: the PEM body, trimmed. Throws on anything else. */
export function publicCertificate(pem: string): string {
  const text = pem.trim();
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(text)) {
    throw new Error("The retrieved certificate is not a single PEM certificate.");
  }
  if (/PRIVATE KEY/.test(text)) throw new Error("The retrieved certificate holds a private key. Stopping.");
  return text;
}

/** Fills the certificate into the app's global OAuth settings. */
export function fillCertificate(xml: string, certificate: string): string {
  return xml.split(PLACEHOLDERS.certificate).join(certificate);
}

/**
 * Fills My Domain, the consumer key and the audience into the external credential or the named credential. The
 * values are written as they are: iss and sub stay unquoted and aud keeps its &quot; quotes from the tracked file
 * (phase 3c).
 */
export function fillCredential(xml: string, values: { myDomain: string; consumerKey: string; audience: string }): string {
  for (const [name, value] of Object.entries(values)) {
    if (!value || /[<>&"\s]/.test(value)) throw new Error(`The ${name} to fill is empty or holds a character XML would need escaped.`);
  }
  return xml
    .split(PLACEHOLDERS.myDomain)
    .join(values.myDomain)
    .split(PLACEHOLDERS.consumerKey)
    .join(values.consumerKey)
    .split(PLACEHOLDERS.audience)
    .join(values.audience);
}

/** Any placeholder still in a filled file, so the setup stops before it deploys one. */
export function unfilled(xml: string): string[] {
  return Object.values(PLACEHOLDERS).filter((p) => xml.includes(p));
}

/**
 * The certificate's own name, and the name it takes for a moment during a renewal. A renewal ends with a new
 * certificate under the first name, so the removal manifest and the tracked external credential always name it.
 */
export const CERTIFICATE_NAMES = [CALLOUT_NAME, `${CALLOUT_NAME}2`] as const;
const [MAIN, STANDBY] = CERTIFICATE_NAMES;

/** A certificate in the org, as the Tooling API lists it. */
export interface OrgCertificate {
  name: string;
  created: string;
}

/** One switch of the certificate: make one (or not), point the app and the external credential at it, remove the old. */
export interface CertificateHop {
  make: boolean;
  use: string;
  remove: string[];
}

/** Our certificates in the org, newest first. Other certificates are never touched. */
function ours(present: readonly OrgCertificate[]): OrgCertificate[] {
  return present
    .filter((c) => (CERTIFICATE_NAMES as readonly string[]).includes(c.name))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

/**
 * The setup's certificate: the one in the org, or a new one when the org has none. When the second name is in the
 * org, a renewal stopped part way, and the setup stops too so it does not point the app at a half-switched pair.
 */
export function setupCertificate(present: readonly OrgCertificate[]): CertificateHop {
  const found = ours(present);
  if (found.some((c) => c.name === STANDBY)) {
    throw new Error(`The org holds the certificate ${STANDBY}, so a renewal stopped part way. Run npm run callout:renew to finish it.`);
  }
  return found.length ? { make: false, use: MAIN, remove: [] } : { make: true, use: MAIN, remove: [] };
}

/**
 * The switches a renewal makes, from what the org holds when it starts. From the first name alone it takes two: to a
 * new certificate under the second name, then to a new one under the first, each in one deploy and each removing the
 * certificate it leaves. When the org holds the second name, an earlier renewal stopped part way, and the renewal
 * finishes it: from both names it keeps the newer and removes the older, then goes on to the first name if needed.
 * It refuses an org with no certificate of ours, since there is nothing to renew.
 */
export function renewalHops(present: readonly OrgCertificate[]): CertificateHop[] {
  const found = ours(present);
  const back: CertificateHop = { make: true, use: MAIN, remove: [STANDBY] };
  if (!found.length) throw new Error(`The org has no certificate ${MAIN} to renew. Run npm run callout:setup first.`);
  if (found.length === 1) return found[0].name === MAIN ? [{ make: true, use: STANDBY, remove: [MAIN] }, back] : [back];
  const [newer, older] = found;
  const finish: CertificateHop = { make: false, use: newer.name, remove: [older.name] };
  return newer.name === MAIN ? [finish] : [finish, back];
}

/** The certificate's metadata file under another name: its masterLabel set to that name. */
export function certificateMeta(xml: string, name: string): string {
  const label = /<masterLabel>[^<]*<\/masterLabel>/g;
  if ((xml.match(label) ?? []).length !== 1) throw new Error("The certificate's metadata file does not hold exactly one masterLabel.");
  return xml.replace(label, `<masterLabel>${name}</masterLabel>`);
}

/** Points the external credential's signing certificate at the named certificate. */
export function fillSigningCertificate(xml: string, name: string): string {
  if (!(CERTIFICATE_NAMES as readonly string[]).includes(name)) throw new Error(`${name} is not a certificate name of callout-app.`);
  const signing = /<certificate>[^<]*<\/certificate>/g;
  if ((xml.match(signing) ?? []).length !== 1) throw new Error("The external credential does not hold exactly one signing certificate.");
  return xml.replace(signing, `<certificate>${name}</certificate>`);
}

/** A destructive manifest that removes the named certificates and nothing else. */
export function certificateRemoval(names: readonly string[], apiVersion: string): string {
  if (!names.length) throw new Error("No certificate to remove.");
  for (const n of names) {
    if (!(CERTIFICATE_NAMES as readonly string[]).includes(n)) throw new Error(`${n} is not a certificate name of callout-app.`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    "    <types>",
    ...names.map((n) => `        <members>${n}</members>`),
    "        <name>Certificate</name>",
    "    </types>",
    `    <version>${apiVersion}</version>`,
    "</Package>",
    "",
  ].join("\n");
}
