import { randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { penathonTools, penathonResult } from './tools';
import { redact } from '../engines/common';

type Run = {
  botId: string;
  runId: string;
  conversationId: string;
  chief: boolean;
  signal: AbortSignal;
  call(name: string, args: unknown): Promise<unknown>;
};
type Session = Run & { servers: Set<McpServer>; responses: Set<ServerResponse>; revoke(): void };

export class PenathonHttpServer {
  private server?: Server;
  private starting?: Promise<string>;
  private sessions = new Map<string, Session>();

  private start(): Promise<string> {
    if (this.starting) return this.starting;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = 0;
    this.server = server;
    this.starting = new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.unref();
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('MCP listen failed'));
        resolve(`http://127.0.0.1:${address.port}/mcp`);
      });
    });
    return this.starting;
  }
  async register(run: Run): Promise<{ url: string; token: string; revoke(): void }> {
    const url = await this.start();
    if (run.signal.aborted) throw new Error('Run cancelled');
    const token = randomBytes(32).toString('hex');
    const revoke = () => {
      const session = this.sessions.get(token);
      if (!session) return;
      this.sessions.delete(token);
      run.signal.removeEventListener('abort', revoke);
      for (const response of session.responses) response.destroy();
      for (const server of session.servers) void server.close().catch(() => {});
    };
    this.sessions.set(token, { ...run, servers: new Set(), responses: new Set(), revoke });
    run.signal.addEventListener('abort', revoke, { once: true });
    return { url, token, revoke };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.signal.aborted) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = new McpServer({ name: 'team', version: '1.0.0' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [req.socket.localAddress + ':' + req.socket.localPort],
      allowedOrigins: [],
    });
    const call = (name: string, args: unknown) => {
      if (this.sessions.get(token!) !== session || session.signal.aborted)
        throw new Error('Run cancelled');
      return session.call(name, redact(args, [token!]));
    };
    for (const { name, schema, description } of penathonTools(session.chief))
      server.registerTool(name, { description, inputSchema: schema }, async (args: unknown) =>
        redact(await penathonResult(call, name, args), [token!]),
      );
    session.servers.add(server);
    session.responses.add(res);
    res.once('close', () => {
      session.servers.delete(server);
      session.responses.delete(res);
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
      session.servers.delete(server);
      await server.close().catch(() => {});
    }
  }
  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.revoke();
    const server = this.server;
    if (!server) return;
    await this.starting?.catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.starting = undefined;
  }
}
