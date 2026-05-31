/**
 * Standard MCP over SSE
 *
 * Mounts the GitNexus MCP server on Express using standard SSEServerTransport.
 * Supports per-session scoping via 'projects' and 'env' headers during SSE establishment.
 */

import type { Express, Request, Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMCPServer } from '../mcp/server.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';

const parseCsvHeader = (value: Request['headers'][string]): string[] | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
};

export function mountMCPEndpoints(app: Express, backend: LocalBackend): () => Promise<void> {
  // Map to track active transports for message routing
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req: Request, res: Response) => {
    // 1. Capture scoping headers from the initial GET request
    const projects = parseCsvHeader(req.headers['projects']);
    const envs = parseCsvHeader(req.headers['env']);
    const scope = projects || envs ? { projects, envs } : undefined;
    if (envs) {
      console.log(`[MCP] New session with env scope: ${envs.join(', ')}`);
    }

    // 2. Initialize standard SSE transport
    const transport = new SSEServerTransport('/api/mcp/messages', res);

    // 3. Create a dedicated server instance for this session with its own whitelist
    const server = createMCPServer(backend, scope);

    await server.connect(transport);

    // Store transport for POST message routing
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    const protocolOnClose = transport.onclose;
    let closed = false;
    transport.onclose = () => {
      if (closed) return;
      closed = true;
      transports.delete(sessionId);
      protocolOnClose?.();
    };
  });

  app.post('/api/mcp/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      res.status(400).send('Missing sessionId');
      return;
    }

    const transport = transports.get(sessionId);

    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  const cleanup = async () => {
    const activeTransports = [...transports.values()];
    transports.clear();
    await Promise.allSettled(activeTransports.map((t) => t.close()));
  };

  console.log('Standard MCP SSE endpoints mounted at /sse and /api/mcp/messages');
  return cleanup;
}
