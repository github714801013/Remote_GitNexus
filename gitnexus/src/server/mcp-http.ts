/**
 * Standard MCP over SSE
 *
 * Mounts the GitNexus MCP server on Express using standard SSEServerTransport.
 * Supports per-session scoping via 'projects' header during SSE establishment.
 */

import type { Express, Request, Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMCPServer } from '../mcp/server.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';

export function mountMCPEndpoints(app: Express, backend: LocalBackend): () => Promise<void> {
  // Map to track active transports for message routing
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req: Request, res: Response) => {
    // 1. Capture scoping headers from the initial GET request
    const projectsHeader = req.headers['projects'];
    let whitelist: string[] | undefined;
    if (typeof projectsHeader === 'string' && projectsHeader.trim().length > 0) {
      whitelist = projectsHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      console.log(`[MCP] New session with project whitelist: ${whitelist.join(', ')}`);
    }

    // 2. Initialize standard SSE transport
    const transport = new SSEServerTransport('/api/mcp/messages', res);

    // 3. Create a dedicated server instance for this session with its own whitelist
    const server = createMCPServer(backend, whitelist);

    await server.connect(transport);

    // Store transport for POST message routing
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    transport.onclose = () => {
      transports.delete(sessionId);
      void server.close();
    };
  });

  app.post('/api/mcp/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  const cleanup = async () => {
    const closers = [...transports.values()].map((t) => t.close());
    transports.clear();
    await Promise.allSettled(closers);
  };

  console.log('Standard MCP SSE endpoints mounted at /sse and /api/mcp/messages');
  return cleanup;
}
