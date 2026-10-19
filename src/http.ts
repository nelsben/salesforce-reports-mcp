import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

export interface HttpOptions {
  port: number;
  host: string;
  /** Builds one McpServer per session. */
  createServer: () => McpServer;
}

export interface HttpHandle {
  port: number;
  host: string;
  close: () => Promise<void>;
}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(`--host ${host} is not loopback. A non-loopback host needs the OAuth layer, which a later change adds.`);
  }
}

// Express request and response types are not imported here; the SDK's own types are enough.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function startHttpServer(options: HttpOptions): Promise<HttpHandle> {
  assertLoopbackHost(options.host);
  const app = createMcpExpressApp({ host: options.host });
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const reject = (res: any, status: number, message: string) => {
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  };

  app.post("/mcp", async (req: any, res: any) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId || !isInitializeRequest(req.body)) {
        reject(res, 400, "Bad Request: no valid session. Send an initialize request first.");
        return;
      }
      const server = options.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) reject(res, 500, "Internal server error");
    }
  });

  const bySession = async (req: any, res: any) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (!existing) {
        reject(res, 400, "Bad Request: unknown or missing session id.");
        return;
      }
      await existing.transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) reject(res, 500, "Internal server error");
    }
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  const httpServer: Server = await new Promise((resolve, reject2) => {
    const s: Server = app.listen(options.port, options.host, () => resolve(s));
    s.on("error", reject2);
  });
  const port = (httpServer.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(async ({ transport, server }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    })();
    return closing;
  };
  return { port, host: options.host, close };
}
