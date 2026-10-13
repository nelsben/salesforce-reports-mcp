/**
 * Deploys the optional callout-app package: a per-user JWT named credential that lets the hosted MCP door call the
 * org's own REST API as the signed-in user (docs/decisions/0012). Run it after force-app. It needs neither mcp-app nor
 * this script's earlier runs, and running it again is safe.
 *
 * Usage, from the repo root:  npx tsx salesforce/scripts/callout-setup.ts --org <alias> [--yes] [--ignore-conflicts] [--renew-certificate]
 *
 * The tracked files hold placeholders only. This script copies callout-app to a temp folder, fills it there, deploys
 * from there in four steps and deletes the copy. It fills the public certificate the org made, the org's My Domain
 * and the app's consumer key (a client id, read from a listing that holds no secret). It never reads a consumer
 * secret, a token or a private key, and prints none of the filled values. --ignore-conflicts is passed to each deploy,
 * for a scratch org whose source tracking still remembers an earlier removal.
 *
 * --renew-certificate (npm run callout:renew) renews the certificate of an installed callout-app before it expires.
 * The org makes a new key pair, one deploy points the app's global OAuth settings and the external credential's
 * signing certificate at it, and the old certificate is removed. It does this twice, through the second name and back,
 * so the certificate in use ends under its own name, new. Permission set assignments are untouched and no user clicks
 * anything. A renewal passes --ignore-conflicts to each deploy, since it overwrites what the setup deployed.
 *
 * Afterwards, assign the permission set Salesforce_Reports_Callout to each user of the hosted MCP server.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALLOUT_NAME,
  CALLOUT_PERMISSION_SET,
  CERTIFICATE_NAMES,
  certificateMeta,
  certificateRemoval,
  type CertificateHop,
  FILES,
  fillCertificate,
  fillCredential,
  fillSigningCertificate,
  myDomainOf,
  publicCertificate,
  RENEWAL,
  renewalHops,
  setupCertificate,
  STEPS,
  unfilled,
} from "./callout-app.js";
import { announce, API_VERSION, Org, orgAndFlagsFromArgs, type Json } from "./org.js";

const USAGE = "npx tsx salesforce/scripts/callout-setup.ts --org <alias> [--yes] [--ignore-conflicts] [--renew-certificate]";
const { org: alias, flags } = orgAndFlagsFromArgs(USAGE, ["ignore-conflicts", "renew-certificate"] as const);
const renew = flags["renew-certificate"];
const org = new Org(alias);
await announce(org);

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "callout-app");
const work = mkdtempSync(join(tmpdir(), "callout-app-"));
const src = join(work, "callout-app", "main", "default");
// A renewal overwrites components the setup deployed, which a scratch org's source tracking reports as conflicts with
// this temp project. So a renewal always ignores them.
const conflicts = flags["ignore-conflicts"] || renew ? ["--ignore-conflicts"] : [];

/** Runs the sf CLI in the temp project and answers its JSON result. On failure, prints only the error and its component problems. */
function sf(args: string[]): Json {
  let out: string;
  try {
    out = execFileSync("sf", [...args, "--json"], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
    if (!out) throw new Error(`sf ${args[0]} ${args[1]} failed with no output.`);
  }
  const parsed = JSON.parse(out);
  if (parsed.status !== 0) {
    const failures: Json[] = [parsed.result?.details?.componentFailures ?? []].flat();
    const problems = failures.map((f) => `${f.componentType} ${f.fullName}: ${f.problem}`);
    throw new Error([`sf ${args[0]} ${args[1]} failed${parsed.message ? `: ${parsed.message}` : "."}`, ...problems].join("\n  "));
  }
  return parsed.result;
}

function deploy(folders: readonly string[]): void {
  const dirs = folders.flatMap((f) => ["-d", join("callout-app", "main", "default", f)]);
  sf(["project", "deploy", "start", ...dirs, "-o", alias, "--wait", "10", ...conflicts]);
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry === name) return path;
  }
  return undefined;
}

function edit(file: string, change: (xml: string) => string): void {
  const path = join(src, file);
  const filled = change(readFileSync(path, "utf8"));
  const left = unfilled(filled);
  if (left.length) throw new Error(`${file} still holds ${left.join(", ")}.`);
  writeFileSync(path, filled);
}

/** Our certificates in the org, from the Tooling API. Other certificates are never read. */
async function orgCertificates(): Promise<{ name: string; created: string }[]> {
  const names = CERTIFICATE_NAMES.map((n) => `'${n}'`).join(", ");
  const rows = await org.tooling(`SELECT DeveloperName, CreatedDate FROM Certificate WHERE DeveloperName IN (${names})`);
  return rows.map((r: Json) => ({ name: r.DeveloperName, created: r.CreatedDate }));
}

/** Renames the temp copy's certificate files to the given name, so the certs folder deploys only that certificate. */
function nameCertificate(name: string): void {
  if (name === CALLOUT_NAME) return;
  const certs = join(src, "certs");
  renameSync(join(certs, `${CALLOUT_NAME}.crt`), join(certs, `${name}.crt`));
  const meta = join(certs, `${CALLOUT_NAME}.crt-meta.xml`);
  writeFileSync(join(certs, `${name}.crt-meta.xml`), certificateMeta(readFileSync(meta, "utf8"), name));
  rmSync(meta);
}

/** Reads back the named certificate's public part. A Certificate retrieve holds no private key, and publicCertificate checks. */
function retrieveCertificate(name: string): string {
  const retrieved = mkdtempSync(join(work, `retrieved-${name}-`));
  sf(["project", "retrieve", "start", "-m", `Certificate:${name}`, "-o", alias, "--target-metadata-dir", retrieved, "--unzip"]);
  const certFile = existsSync(retrieved) ? findFile(retrieved, `${name}.crt`) : undefined;
  if (!certFile) throw new Error(`The certificate ${name} could not be read back from the org.`);
  return publicCertificate(readFileSync(certFile, "utf8"));
}

/** Removes the named certificates with a destructive deploy built in the temp folder. */
function removeCertificates(names: string[]): void {
  const dir = join(work, `remove-${names.join("-")}`);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "package.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>${API_VERSION}</version>\n</Package>\n`,
  );
  writeFileSync(join(dir, "destructiveChanges.xml"), certificateRemoval(names, API_VERSION));
  sf(["project", "deploy", "start", "--manifest", join(dir, "package.xml"), "--post-destructive-changes", join(dir, "destructiveChanges.xml"), "-o", alias, "--wait", "10", ...conflicts]);
}

/** The exact expiry of a public certificate, for the summary line. Not a secret. */
function expiryOf(pem: string): string {
  return new Date(new X509Certificate(pem).validTo).toISOString();
}

/** A fresh temp copy of callout-app, with its placeholders, for one deploy pass. */
function freshCopy(): void {
  rmSync(join(work, "callout-app"), { recursive: true, force: true });
  cpSync(source, join(work, "callout-app"), { recursive: true });
}

/** The values the credentials take: My Domain, and the app's consumer key (a client id, not a secret). */
async function credentialValues(): Promise<{ myDomain: string; consumerKey: string; audience: string }> {
  const myDomain = myDomainOf((await org.connection.getAuth()).instanceUrl);
  const apps: Json[] = (
    await org.request("GET", `/services/data/v${API_VERSION}/query?q=${encodeURIComponent(`SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '${CALLOUT_NAME}'`)}`)
  ).records;
  if (apps.length !== 1) throw new Error(`Expected one External Client App named ${CALLOUT_NAME}, found ${apps.length}.${renew ? " Run npm run callout:setup first." : ""}`);
  const listing = await org.request("GET", `/services/data/v${API_VERSION}/apps/oauth/credentials/${apps[0].Id}`);
  const consumerKey: unknown = listing?.consumers?.[0]?.key;
  if (typeof consumerKey !== "string" || !consumerKey) throw new Error("Could not read the app's consumer key.");
  return { myDomain, consumerKey, audience: `https://${myDomain}` };
}

/** Deploys a new certificate under the hop's name. The org makes the key pair, and the private key never leaves it. */
function makeCertificate(name: string): void {
  freshCopy();
  nameCertificate(name);
  deploy(STEPS.certificate);
}

/** One renewal switch: the new certificate made, the app and the external credential pointed at it in one deploy, the old one removed. */
async function hop(step: number, h: CertificateHop): Promise<string> {
  if (h.make) {
    console.log(`${step}a. Certificate ${h.use}: a new self-signed key pair made in the org. The private key never leaves it.`);
    makeCertificate(h.use);
  } else {
    console.log(`${step}a. Certificate ${h.use}: made by an earlier renewal that stopped part way. Finishing that switch.`);
  }
  freshCopy();
  const certificate = retrieveCertificate(h.use);
  const values = await credentialValues();
  edit(FILES.globalOauth, (xml) => fillCertificate(xml, certificate));
  edit(FILES.externalCredential, (xml) => fillSigningCertificate(fillCredential(xml, values), h.use));
  console.log(`${step}b. The app's global OAuth settings and the external credential's signing certificate, switched to ${h.use} in one deploy.`);
  deploy(RENEWAL);
  console.log(`${step}c. Old certificate ${h.remove.join(", ")}: removed.`);
  removeCertificates(h.remove);
  return certificate;
}

async function renewal(): Promise<void> {
  const hops = renewalHops(await orgCertificates());
  const before = hops[0].remove.find((n) => n === CALLOUT_NAME);
  const oldExpiry = before ? expiryOf(retrieveCertificate(before)) : undefined;
  let certificate = "";
  for (const [i, h] of hops.entries()) certificate = await hop(i + 1, h);
  const last = hops[hops.length - 1].use;
  console.log(`\nDone. Certificate ${last} is new and in use. It expires ${expiryOf(certificate)}.${oldExpiry ? ` The old one was to expire ${oldExpiry}.` : ""}`);
  console.log("Permission set assignments are unchanged.");
}

async function setup(): Promise<void> {
  const plan = setupCertificate(await orgCertificates());
  if (plan.make) {
    console.log(`1. Certificate ${plan.use}: a self-signed key pair made in the org. The private key never leaves it.`);
    makeCertificate(plan.use);
  } else {
    console.log(`1. Certificate ${plan.use}: already in the org, kept.`);
  }

  console.log("2. External Client App, with the certificate's public part for the JWT bearer flow.");
  freshCopy();
  const certificate = retrieveCertificate(plan.use);
  edit(FILES.globalOauth, (xml) => fillCertificate(xml, certificate));
  deploy(STEPS.app);

  console.log("3. External credential, named credential and permission set, with the app's consumer key (a client id, not a secret).");
  const values = await credentialValues();
  edit(FILES.externalCredential, (xml) => fillCredential(xml, values));
  edit(FILES.namedCredential, (xml) => fillCredential(xml, values));
  deploy(STEPS.credential);

  console.log("4. App policy: users with the permission set are pre-authorized.");
  deploy(STEPS.policy);

  console.log(`\nDone. Certificate ${plan.use} expires ${expiryOf(certificate)}. Renew it before then with npm run callout:renew.`);
  console.log(`Assign the permission set to each user of the hosted MCP server:\n  sf org assign permset -n ${CALLOUT_PERMISSION_SET} -o ${alias}`);
}

try {
  writeFileSync(
    join(work, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "callout-app", default: true }], name: "callout-app-setup", namespace: "", sourceApiVersion: API_VERSION }),
  );
  await (renew ? renewal() : setup());
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
