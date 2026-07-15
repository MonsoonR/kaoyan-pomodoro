import type { MetadataRow } from './types';

export function createMetadata(userId: string): MetadataRow {
  return {
    userId,
    cursor: 0,
    activeUserId: null,
    lastSuccessfulSyncAt: null,
    lastAttemptAt: null,
    authState: 'unknown',
    latestKnownServerCursor: 0,
    clockOffsetMs: null,
    clockMeasuredAt: null,
    clockUncertaintyMs: null,
    pendingCount: 0,
    username: null,
    deviceId: null,
    deviceName: null,
    sessionExpiresAt: null,
    role: null,
    mustChangePassword: false,
  };
}
