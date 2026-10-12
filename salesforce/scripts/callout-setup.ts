/**
 * Deploys the optional callout-app package: a per-user JWT named credential that lets the hosted MCP door call the
 * org's own REST API as the signed-in user (docs/decisions/0012). Run it after force-app. It needs neither mcp-app nor
 * this script's earlier runs, and running it again is safe.
 *
 * Usage, from the repo root:  npx tsx salesforce/scripts/callout-setup.ts --org <alias> [--yes] [--ignore-conflicts]
 *
 * The tracked files hold placeholders only. This script copies callout-app to a temp folder, fills it there, deploys
 * from there in four steps and deletes the copy. It fills the public certificate the org made, the org's My Domain
 * and the app's consumer key (a client id, read from a listing that holds no secret). It never reads a consumer
 * secret, a token or a private key, and prints none of the filled values. --ignore-conflicts is passed to each deploy,
 * for a scratch org whose source tracking still remembers an earlier removal.
 *
 * Afterwards, assign the permission set Salesforce_Reports_Callout to each user of the hosted MCP server.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALLOUT_NAME,
  CALLOUT_PERMISSION_SET,
  FILES,
  fillCertificate,
  fillCredential,
  myDomainOf,
  publicCertificate,
  STEPS,
  unfilled,
} from "./callout-app.js";
import { announce, API_VERSION, Org, orgAndFlagsFromArgs, type Json } from "./org.js";

const USAGE = "npx tsx salesforce/scripts/callout-setup.ts --org <alias> [--yes] [--ignore-conflicts]";
const { org: alias, flags } = orgAndFlagsFromArgs(USAGE, ["ignore-conflicts"] as const);
const org = new Org(alias);
await announce(org);

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "callout-app");
const work = mkdtempSync(join(tmpdir(), "callout-app-"));
const src = join(work, "callout-app", "main", "default");

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
  sf(["project", "deploy", "start", ...dirs, "-o", alias, "--wait", "10", ...(flags["ignore-conflicts"] ? ["--ignore-conflicts"] : [])]);
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

try {
  cpSync(source, join(work, "callout-app"), { recursive: true });
  writeFileSync(
    join(work, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "callout-app", default: true }], name: "callout-app-setup", namespace: "", sourceApiVersion: API_VERSION }),
  );

  const myDomain = myDomainOf((await org.connection.getAuth()).instanceUrl);

  const certificates: Json[] = [sf(["org", "list", "metadata", "-m", "Certificate", "-o", alias]) ?? []].flat();
  if (certificates.some((c) => c.fullName === CALLOUT_NAME)) {
    console.log(`1. Certificate ${CALLOUT_NAME}: already in the org, kept.`);
  } else {
    console.log(`1. Certificate ${CALLOUT_NAME}: a self-signed key pair made in the org. The private key never leaves it.`);
    deploy(STEPS.certificate);
  }

  console.log("2. External Client App, with the certificate's public part for the JWT bearer flow.");
  const retrieved = join(work, "retrieved");
  sf(["project", "retrieve", "start", "-m", `Certificate:${CALLOUT_NAME}`, "-o", alias, "--target-metadata-dir", retrieved, "--unzip"]);
  const certFile = existsSync(retrieved) ? findFile(retrieved, `${CALLOUT_NAME}.crt`) : undefined;
  if (!certFile) throw new Error("The certificate could not be read back from the org.");
  const certificate = publicCertificate(readFileSync(certFile, "utf8"));
  edit(FILES.globalOauth, (xml) => fillCertificate(xml, certificate));
  deploy(STEPS.app);

  console.log("3. External credential, named credential and permission set, with the app's consumer key (a client id, not a secret).");
  const apps: Json[] = (
    await org.request("GET", `/services/data/v${API_VERSION}/query?q=${encodeURIComponent(`SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '${CALLOUT_NAME}'`)}`)
  ).records;
  if (apps.length !== 1) throw new Error(`Expected one External Client App named ${CALLOUT_NAME}, found ${apps.length}.`);
  const listing = await org.request("GET", `/services/data/v${API_VERSION}/apps/oauth/credentials/${apps[0].Id}`);
  const consumerKey: unknown = listing?.consumers?.[0]?.key;
  if (typeof consumerKey !== "string" || !consumerKey) throw new Error("Could not read the app's consumer key.");
  const values = { myDomain, consumerKey, audience: `https://${myDomain}` };
  edit(FILES.externalCredential, (xml) => fillCredential(xml, values));
  edit(FILES.namedCredential, (xml) => fillCredential(xml, values));
  deploy(STEPS.credential);

  console.log("4. App policy: users with the permission set are pre-authorized.");
  deploy(STEPS.policy);

  console.log(`\nDone. Assign the permission set to each user of the hosted MCP server:\n  sf org assign permset -n ${CALLOUT_PERMISSION_SET} -o ${alias}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
