# 0001. One tool contract across three doors

Status: Accepted, 2026-10-11

## Context

People reach Salesforce from different places. A developer runs Claude Code on a laptop with the Salesforce CLI signed in. A seller uses claude.ai in a browser and cannot run a local process. An admin wants Flow or Agentforce to call the same capability. Building a separate product for each would split the skills, the docs and the tests three ways.

## Decision

There is one contract: twelve tool names, one input shape (`ReportDefinition`) and one output shape (`ReportResult`), written down in [design.md](../design.md). Three doors implement it:

| Door | Implementation |
| --- | --- |
| Local MCP | TypeScript, on the user's machine |
| In-org REST | Apex `@RestResource` |
| In-org hosted MCP | Salesforce's MCP gateway over the in-org REST door |

The skills name tools, never transports. A door that lacks a tool leaves it out or refuses it with a code the skills know.

## Consequences

- A skill written once works on every door. Proving that is a test, not a promise: see [0010](0010-verification-by-parity.md).
- The contract is the expensive thing to change. A new field lands in the TypeScript, the Apex, the generated OpenAPI and the parity cases together.
- Two implementations of the same logic (TypeScript and Apex) is the main cost. It is accepted because Apex cannot call out to a Node process, and a Node process cannot run inside Salesforce.

## Alternatives

- **One implementation, in the org only.** Rejected: it would make every user install a package before trying anything, and v0.1 needs nothing in the org.
- **One implementation, local only, reached from the org by callout.** Rejected: the org would depend on a server someone has to host.
- **A different tool set per door.** Rejected: the skills would fork.
