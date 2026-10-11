/**
 * Writes the hosted MCP door's metadata from the local server's tool list, so names, descriptions and input
 * schemas cannot drift from src/server.ts:
 * - the ExternalServiceRegistration for ReportsApi: one POST operation per door tool, operationId equal to the
 *   tool name, request body schema equal to the tool's inputSchema (as OpenAPI 3.0: $ref inlined, type lists
 *   as anyOf, no $schema);
 * - the McpServerDefinition SalesforceReports with one <tools> entry per door tool (ar:ReportsApi, API_CATALOG).
 *
 * Usage, from the repo root:
 *   npm run mcp:generate              write both files
 *   npm run mcp:generate -- --check   exit 1 if a committed file is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doorTools, type DoorTool } from "./door-tools.js";
import { API_IDENTIFIER, API_SOURCE, REGISTRATION, SERVER } from "./org.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;


const DEFAULT = join(dirname(fileURLToPath(import.meta.url)), "..", "force-app", "main", "default");
const REGISTRATION_FILE = join(DEFAULT, "externalServiceRegistrations", `${REGISTRATION}.externalServiceRegistration-meta.xml`);
const SERVER_FILE = join(DEFAULT, "mcpServerDefinitions", `${SERVER}.mcpServerDefinition-meta.xml`);

/** Salesforce names an operation after its operationId, with "_" written as "x5f". */
export function operationName(tool: string): string {
  return tool.replace(/_/g, "x5f");
}

/** A JSON Schema (draft 7, as the MCP SDK emits it) as an OpenAPI 3.0 schema object. */
export function toOpenApiSchema(root: Json): Json {
  const resolve = (pointer: string): Json => {
    if (!pointer.startsWith("#/")) throw new Error(`Cannot inline the reference ${pointer}.`);
    return pointer
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((node: Json, key) => node?.[key], root);
  };
  const walk = (node: Json, depth: number): Json => {
    if (depth > 40) throw new Error("The schema nests too deep to inline.");
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1));
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const { $ref, ...rest } = node;
      return walk({ ...resolve($ref), ...rest }, depth + 1);
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema") continue;
      if (key === "type" && Array.isArray(value)) continue;
      if (key === "additionalProperties" && value && typeof value === "object" && !Object.keys(value).length) {
        out[key] = true;
        continue;
      }
      out[key] = key === "properties" ? Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, walk(v, depth + 1)])) : walk(value, depth + 1);
    }
    if (Array.isArray(node.type)) out.anyOf = node.type.map((t: string) => ({ type: t }));
    return out;
  };
  return walk(root, 0);
}

/** The OpenAPI 3.0 document for the door. */
export function openApiDocument(tools: DoorTool[]): Json {
  const error = {
    description: "The error body the door returns.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" }, hint: { type: "string" } },
            },
          },
        },
      },
    },
  };
  const paths: Json = {};
  for (const tool of tools) {
    paths[`/reports/v1/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: tool.description,
        requestBody: {
          required: true,
          content: { "application/json": { schema: toOpenApiSchema(tool.inputSchema) } },
        },
        responses: {
          "200": {
            description: "The JSON the local tool returns.",
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
          "400": error,
          "404": error,
          "500": error,
        },
      },
    };
  }
  return {
    openapi: "3.0.0",
    info: {
      title: REGISTRATION,
      version: "1.0.0",
      description: "The in-org REST door for the Salesforce reports runner tools. Generated from src/server.ts by salesforce/scripts/generate-metadata.ts.",
    },
    servers: [{ url: "/services/apexrest" }],
    paths,
  };
}

/** YAML for a JSON value: block mappings, JSON-quoted strings, flow lists of scalars. */
export function toYaml(value: Json, indent = ""): string {
  const scalar = (v: Json) => (typeof v === "string" ? JSON.stringify(v) : String(v));
  const isScalar = (v: Json) => v === null || typeof v !== "object";
  if (isScalar(value)) return scalar(value);
  const lines: string[] = [];
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return `[${value.map(scalar).join(", ")}]`;
    for (const item of value) {
      const body = toYaml(item, `${indent}  `);
      lines.push(isScalar(item) ? `${indent}- ${body}` : `${indent}-\n${body}`);
    }
    return lines.join("\n");
  }
  for (const [key, v] of Object.entries(value as Record<string, Json>)) {
    const k = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) lines.push(`${indent}${k}: ${toYaml(v)}`);
    else if (Array.isArray(v) ? !v.length : !Object.keys(v).length) lines.push(`${indent}${k}: ${Array.isArray(v) ? "[]" : "{}"}`);
    else lines.push(`${indent}${k}:\n${toYaml(v, `${indent}  `)}`);
  }
  return lines.join("\n");
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function registrationXml(tools: DoorTool[]): string {
  const operations = tools
    .map((t) => `    <operations>\n        <active>true</active>\n        <name>${operationName(t.name)}</name>\n    </operations>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>The in-org REST door for the report runner tools, as an API Catalog entry for the hosted MCP server. Generated by salesforce/scripts/generate-metadata.ts.</description>
    <label>${REGISTRATION}</label>
${operations}
    <registrationProviderAsset>${REGISTRATION}</registrationProviderAsset>
    <registrationProviderType>ApexRest</registrationProviderType>
    <schema>${escapeXml(toYaml(openApiDocument(tools)))}
</schema>
    <schemaType>OpenApi3</schemaType>
    <systemVersion>3</systemVersion>
</ExternalServiceRegistration>
`;
}

/** The server definition with one tool per door tool. Deploying it replaces the server's tool list. */
export function serverXml(tools: DoorTool[]): string {
  const entries = tools
    .map(
      (t) => `    <tools>
        <apiDefinition>
            <apiIdentifier>${API_IDENTIFIER}</apiIdentifier>
            <apiSource>${API_SOURCE}</apiSource>
            <operation>${t.name}</operation>
        </apiDefinition>
        <descriptionOverride>${escapeXml(t.description)}</descriptionOverride>
        <destructive>false</destructive>
        <idempotent>${t.annotations.idempotentHint ?? true}</idempotent>
        <openWorld>true</openWorld>
        <readOnly>true</readOnly>
        <returnDirect>false</returnDirect>
        <toolName>${t.name}</toolName>
        <toolTitle>${escapeXml(t.title)}</toolTitle>
    </tools>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<McpServerDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Find, describe, run and combine saved Salesforce reports. Six read-only tools over the ReportsApi Apex REST class. Generated by salesforce/scripts/generate-metadata.ts.</description>
    <masterLabel>Salesforce Reports</masterLabel>
${entries}
</McpServerDefinition>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tools = await doorTools();
  const files: [string, string][] = [
    [REGISTRATION_FILE, registrationXml(tools)],
    [SERVER_FILE, serverXml(tools)],
  ];
  if (process.argv.includes("--check")) {
    const stale = files.filter(([path, xml]) => {
      try {
        return readFileSync(path, "utf8") !== xml;
      } catch {
        return true;
      }
    });
    for (const [path] of stale) console.error(`${path} is stale. Run: npm run mcp:generate`);
    if (stale.length) process.exit(1);
    console.log("The registration and the server definition match the local tool list.");
  } else {
    for (const [path, xml] of files) {
      writeFileSync(path, xml);
      console.log(`Wrote ${path}`);
    }
  }
}
