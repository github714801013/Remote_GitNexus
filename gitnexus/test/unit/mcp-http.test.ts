import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mountMCPEndpoints } from '../../src/server/mcp-http.js';

const closeMock = vi.fn();
const connectMock = vi.fn();
const protocolOncloseMock = vi.fn();
let lastTransport: {
  sessionId: string;
  close: ReturnType<typeof vi.fn>;
  handlePostMessage: ReturnType<typeof vi.fn>;
  onclose?: () => void;
};

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
  SSEServerTransport: vi.fn().mockImplementation(function () {
    lastTransport = {
      sessionId: 'session-1',
      close: vi.fn().mockResolvedValue(undefined),
      handlePostMessage: vi.fn().mockResolvedValue(undefined),
      onclose: undefined,
    };
    return lastTransport;
  }),
}));

vi.mock('../../src/mcp/server.js', () => ({
  createMCPServer: vi.fn(() => ({
    connect: connectMock.mockImplementation(async (transport: any) => {
      const previousOnclose = transport.onclose;
      transport.onclose = () => {
        previousOnclose?.();
        protocolOncloseMock();
      };
    }),
    close: closeMock.mockImplementation(async () => {
      await lastTransport.close();
      if (closeMock.mock.calls.length === 1) {
        lastTransport.onclose?.();
      }
    }),
  })),
}));

function createApp() {
  const handlers: Record<string, any> = {};
  return {
    handlers,
    app: {
      get: vi.fn((path: string, handler: any) => {
        handlers[`GET ${path}`] = handler;
      }),
      post: vi.fn((path: string, handler: any) => {
        handlers[`POST ${path}`] = handler;
      }),
    },
  };
}

describe('mountMCPEndpoints close handling', () => {
  beforeEach(() => {
    closeMock.mockClear();
    connectMock.mockClear();
    protocolOncloseMock.mockClear();
  });

  it('lets SDK protocol cleanup run when transport closes', async () => {
    const { app, handlers } = createApp();
    mountMCPEndpoints(app as any, {} as any);

    await handlers['GET /sse']({ headers: {} }, {});
    lastTransport.onclose?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(protocolOncloseMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('cleanup closes active transports without calling server.close recursively', async () => {
    const { app, handlers } = createApp();
    const cleanup = mountMCPEndpoints(app as any, {} as any);

    await handlers['GET /sse']({ headers: {} }, {});
    const transport = lastTransport;
    transport.close.mockImplementation(async () => {
      transport.onclose?.();
    });

    await cleanup();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(protocolOncloseMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('ignores repeated transport close callbacks for the same session', async () => {
    const { app, handlers } = createApp();
    mountMCPEndpoints(app as any, {} as any);

    await handlers['GET /sse']({ headers: {} }, {});
    expect(() => {
      lastTransport.onclose?.();
      lastTransport.onclose?.();
    }).not.toThrow();

    expect(protocolOncloseMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('returns 400 when sessionId is missing or invalid', async () => {
    const { app, handlers } = createApp();
    mountMCPEndpoints(app as any, {} as any);

    for (const sessionId of [undefined, '', ['session-1']]) {
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn() };
      await handlers['POST /api/mcp/messages']({ query: { sessionId }, body: {} }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith('Missing sessionId');
    }
  });

  it('returns 404 for messages after transport closes', async () => {
    const { app, handlers } = createApp();
    mountMCPEndpoints(app as any, {} as any);

    await handlers['GET /sse']({ headers: {} }, {});
    const transport = lastTransport;
    transport.onclose?.();
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() };

    await handlers['POST /api/mcp/messages']({ query: { sessionId: 'session-1' }, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(transport.handlePostMessage).not.toHaveBeenCalled();
  });
});
