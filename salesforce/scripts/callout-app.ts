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
