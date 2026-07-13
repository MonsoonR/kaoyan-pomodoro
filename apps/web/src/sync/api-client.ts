import {
  ConflictListResponseSchema,
  ConflictSchema,
  CurrentSessionSchema,
  PullChangesResponseSchema,
  PushOperationsResponseSchema,
  TimerStateResponseSchema,
  type SyncOperation,
} from '@kaoyan/contracts';
import {
  AuthRequiredError,
  ForbiddenError,
  NetworkError,
  PayloadTooLargeError,
  ProtocolError,
  RateLimitedError,
  ServerError,
} from './errors';
import type { SyncApiClient } from './types';

interface Parser<T> { parse(value: unknown): T }

export interface ApiClientDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

export function createApiClient(
  dependencies: ApiClientDependencies = {},
): SyncApiClient {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const signalInit = (signal?: AbortSignal): Pick<RequestInit, 'signal'> =>
    signal === undefined ? {} : { signal };

  async function request<T>(
    path: string,
    schema: Parser<T>,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImplementation(path, {
        ...init,
        credentials: 'include',
      });
    } catch {
      throw new NetworkError();
    }
    if (!response.ok) {
      if (response.status === 401) throw new AuthRequiredError();
      if (response.status === 403) throw new ForbiddenError();
      if (response.status === 413) throw new PayloadTooLargeError();
      if (response.status === 429) throw new RateLimitedError();
      if (response.status >= 500) throw new ServerError();
      throw new ProtocolError(`Unexpected HTTP status ${response.status}`);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ProtocolError('The server response was not valid JSON');
    }
    try {
      return schema.parse(value);
    } catch {
      throw new ProtocolError();
    }
  }

  return {
    getCurrentSession: (signal) =>
      request('/api/auth/me', CurrentSessionSchema, {
        method: 'GET', ...signalInit(signal),
      }),
    pushOperations: (operations: readonly SyncOperation[], signal) =>
      request('/api/sync/push', PushOperationsResponseSchema, {
        method: 'POST',
        ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations }),
      }),
    pullChanges: (cursor, limit, signal) =>
      request(
        `/api/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`,
        PullChangesResponseSchema,
        { method: 'GET', ...signalInit(signal) },
      ),
    listConflicts: async (signal) =>
      (await request('/api/conflicts', ConflictListResponseSchema, {
        method: 'GET', ...signalInit(signal),
      })).conflicts,
    getConflict: (conflictId, signal) =>
      request(
        `/api/conflicts/${encodeURIComponent(conflictId)}`,
        ConflictSchema,
        { method: 'GET', ...signalInit(signal) },
      ),
    getTimer: async (signal) => {
      const requestStartedAt = now();
      const data = await request('/api/timer', TimerStateResponseSchema, {
        method: 'GET', ...signalInit(signal),
      });
      const requestEndedAt = now();
      return { data, requestStartedAt, requestEndedAt };
    },
  };
}
