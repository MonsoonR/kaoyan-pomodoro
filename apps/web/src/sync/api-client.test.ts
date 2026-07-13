import { describe, expect, it, vi } from 'vitest';
import { NOW, session } from '../test/fixtures';
import { createApiClient } from './api-client';
import {
  AuthRequiredError,
  NetworkError,
  PayloadTooLargeError,
  ProtocolError,
  RateLimitedError,
  ServerError,
} from './errors';

describe('type-safe sync API client', () => {
  it('uses same-origin credentials and parses the session schema', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(session()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createApiClient({ fetch: fetchMock });
    await expect(client.getCurrentSession()).resolves.toEqual(session());
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      method: 'GET', credentials: 'include',
    }));
  });

  it('sends JSON operations without reading or storing credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ receipts: [], latestCursor: 0 })),
    );
    await createApiClient({ fetch: fetchMock }).pushOperations([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/sync/push', expect.objectContaining({
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [] }),
    }));
  });

  it('classifies HTTP errors without exposing response bodies', async () => {
    for (const [status, error] of [
      [401, AuthRequiredError], [413, PayloadTooLargeError],
      [429, RateLimitedError], [503, ServerError],
    ] as const) {
      const client = createApiClient({
        fetch: async () => new Response('<html>secret stack</html>', { status }),
      });
      await expect(client.getCurrentSession()).rejects.toBeInstanceOf(error);
      await expect(client.getCurrentSession()).rejects.not.toThrow('secret stack');
    }
  });

  it('classifies network and protocol failures', async () => {
    await expect(createApiClient({
      fetch: async () => { throw new TypeError('offline'); },
    }).getCurrentSession()).rejects.toBeInstanceOf(NetworkError);
    await expect(createApiClient({
      fetch: async () => new Response(JSON.stringify({ user: null })),
    }).getCurrentSession()).rejects.toBeInstanceOf(ProtocolError);
  });

  it('records timer request boundaries for clock calibration', async () => {
    const times = [1000, 1100];
    const client = createApiClient({
      now: () => times.shift() ?? 1100,
      fetch: async () => new Response(JSON.stringify({
        timer: null, serverTime: NOW,
      })),
    });
    await expect(client.getTimer()).resolves.toMatchObject({
      requestStartedAt: 1000, requestEndedAt: 1100,
    });
  });

  it('forwards AbortSignal to fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(session())),
    );
    const controller = new AbortController();
    await createApiClient({ fetch: fetchMock })
      .getCurrentSession(controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me',
      expect.objectContaining({ signal: controller.signal }));
  });
});
