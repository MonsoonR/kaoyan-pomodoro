import {
  ApiErrorSchema,
  ConflictListResponseSchema,
  ConflictSchema,
  CurrentSessionSchema,
  DeviceListResponseSchema,
  CreateInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationSchema,
  LoginResponseSchema,
  RegisterWithInviteResponseSchema,
  PullChangesResponseSchema,
  PushOperationsResponseSchema,
  ResolveConflictRequestSchema,
  ResolveConflictResponseSchema,
  SuccessResponseSchema,
  TimerStateResponseSchema,
  type ResolveConflictRequest,
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
  SyncClientError,
} from './errors';
import type { AccountApiClient } from './types';

interface Parser<T> { parse(value: unknown): T }

export interface ApiClientDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

export function createApiClient(
  dependencies: ApiClientDependencies = {},
): AccountApiClient {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const signalInit = (signal?: AbortSignal): Pick<RequestInit, 'signal'> =>
    signal === undefined ? {} : { signal };

  async function request<T>(
    path: string,
    schema: Parser<T>,
    init: RequestInit,
    preserveAuthenticationError = false,
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
      let apiError: { code: string; message: string } | null = null;
      try {
        apiError = ApiErrorSchema.parse(await response.clone().json());
      } catch {
        // Error pages and malformed payloads are never surfaced verbatim.
      }
      if (response.status === 401) {
        if (preserveAuthenticationError && apiError)
          throw new SyncClientError(apiError.code, apiError.message);
        throw new AuthRequiredError();
      }
      if (response.status === 403) throw new ForbiddenError();
      if (response.status === 413) throw new PayloadTooLargeError();
      if (response.status === 429)
        throw new RateLimitedError(apiError?.message);
      if (response.status >= 500) throw new ServerError(apiError?.message);
      if (apiError) throw new SyncClientError(apiError.code, apiError.message);
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
    login: (username, password, signal) =>
      request('/api/auth/login', LoginResponseSchema, {
        method: 'POST',
        ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }, true),
    registerWithInvite: (
      token,
      username,
      password,
      confirmPassword,
      signal,
    ) => request(
      '/api/auth/register-with-invite',
      RegisterWithInviteResponseSchema,
      {
        method: 'POST',
        ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username, password, confirmPassword }),
      },
      true,
    ),
    getCurrentSession: (signal) =>
      request('/api/auth/me', CurrentSessionSchema, {
        method: 'GET', ...signalInit(signal),
      }),
    logout: (signal) =>
      request('/api/auth/logout', SuccessResponseSchema, {
        method: 'POST', ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
      }),
    changePassword: (
      currentPassword,
      newPassword,
      confirmPassword,
      signal,
    ) => request('/api/auth/change-password', SuccessResponseSchema, {
      method: 'POST',
      ...signalInit(signal),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    }, true),
    listDevices: async (signal) =>
      (await request('/api/devices', DeviceListResponseSchema, {
        method: 'GET', ...signalInit(signal),
      })).devices,
    renameDevice: (deviceId, name, signal) =>
      request(
        `/api/devices/${encodeURIComponent(deviceId)}`,
        SuccessResponseSchema,
        {
          method: 'PATCH',
          ...signalInit(signal),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      ),
    revokeDevice: (deviceId, signal) =>
      request(
        `/api/devices/${encodeURIComponent(deviceId)}`,
        SuccessResponseSchema,
        {
          method: 'DELETE',
          ...signalInit(signal),
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    logoutOtherDevices: (signal) =>
      request('/api/devices/logout-others', SuccessResponseSchema, {
        method: 'POST', ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
      }),
    listInvitations: async (signal) =>
      (await request('/api/admin/invites', InvitationListResponseSchema, {
        method: 'GET', ...signalInit(signal),
      })).invitations,
    createInvitation: (expiresInHours, signal) =>
      request('/api/admin/invites', CreateInvitationResponseSchema, {
        method: 'POST',
        ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInHours }),
      }),
    revokeInvitation: (invitationId, signal) =>
      request(
        `/api/admin/invites/${encodeURIComponent(invitationId)}/revoke`,
        InvitationSchema,
        {
          method: 'POST',
          ...signalInit(signal),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      ),
    resolveConflict: (
      conflictId,
      resolution: ResolveConflictRequest,
      signal,
    ) => request(
      `/api/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      ResolveConflictResponseSchema,
      {
        method: 'POST',
        ...signalInit(signal),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ResolveConflictRequestSchema.parse(resolution)),
      },
    ),
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
