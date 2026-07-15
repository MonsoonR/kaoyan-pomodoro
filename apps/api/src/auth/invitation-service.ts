import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Invitation, RegisterWithInviteRequest } from '@kaoyan/contracts';
import { insertInitialSettings } from './account-service';
import { hashPassword } from './password';
import { createSessionRecords, type Services } from './session-service';
import { generateInviteToken, hashInviteToken } from './tokens';
import { normalizeUsername } from './username';

export type InvitationErrorCode =
  | 'INVITE_NOT_FOUND'
  | 'INVITE_USED'
  | 'INVITE_REVOKED'
  | 'INVITE_EXPIRED'
  | 'INVITE_NOT_ACTIVE'
  | 'USERNAME_EXISTS';

export class InvitationError extends Error {
  constructor(
    readonly code: InvitationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface InvitationRow {
  id: string;
  token_hash: string;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
  used_by_username: string | null;
  revoked_at: number | null;
  created_at: number;
}

function statusOf(row: InvitationRow, now: number): Invitation['status'] {
  if (row.used_at !== null) return 'used';
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at <= now) return 'expired';
  return 'active';
}

function toInvitation(row: InvitationRow, now: number): Invitation {
  return {
    id: row.id,
    status: statusOf(row, now),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    usedAt: row.used_at === null ? null : new Date(row.used_at).toISOString(),
    usedBy: row.used_by === null || row.used_by_username === null
      ? null
      : { id: row.used_by, username: row.used_by_username },
    revokedAt: row.revoked_at === null
      ? null
      : new Date(row.revoked_at).toISOString(),
  };
}

const invitationSelect = `
  SELECT i.id, i.token_hash, i.expires_at, i.used_at, i.used_by,
    used.username AS used_by_username, i.revoked_at, i.created_at
  FROM invitations i
  LEFT JOIN users used ON used.id = i.used_by
`;

function errorForStatus(status: Invitation['status']): InvitationError {
  if (status === 'used')
    return new InvitationError('INVITE_USED', 'Invitation has already been used');
  if (status === 'revoked')
    return new InvitationError('INVITE_REVOKED', 'Invitation has been revoked');
  if (status === 'expired')
    return new InvitationError('INVITE_EXPIRED', 'Invitation has expired');
  return new InvitationError('INVITE_NOT_ACTIVE', 'Invitation is not active');
}

export function createInvitationService(
  services: Services,
  generateToken: () => string = generateInviteToken,
) {
  return {
    list(): Invitation[] {
      const now = services.now().getTime();
      const rows = services.sqlite.prepare(
        `${invitationSelect} ORDER BY i.created_at DESC, i.id DESC`,
      ).all() as InvitationRow[];
      return rows.map((row) => toInvitation(row, now));
    },

    create(createdBy: string, expiresInHours: number) {
      const now = services.now().getTime();
      const token = generateToken();
      const id = randomUUID();
      const expiresAt = now + expiresInHours * 60 * 60 * 1000;
      services.sqlite.prepare(`
        INSERT INTO invitations (
          id, token_hash, created_by, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, hashInviteToken(token), createdBy, expiresAt, now);
      const row = services.sqlite.prepare(
        `${invitationSelect} WHERE i.id = ?`,
      ).get(id) as InvitationRow;
      return {
        invitation: toInvitation(row, now),
        inviteUrl: `${services.appOrigin}/#/invite/${encodeURIComponent(token)}`,
      };
    },

    revoke(invitationId: string): Invitation {
      const now = services.now().getTime();
      const current = services.sqlite.prepare(
        `${invitationSelect} WHERE i.id = ?`,
      ).get(invitationId) as InvitationRow | undefined;
      if (!current)
        throw new InvitationError('INVITE_NOT_FOUND', 'Invitation not found');
      const status = statusOf(current, now);
      if (status !== 'active') throw errorForStatus(status);
      const updated = services.sqlite.prepare(`
        UPDATE invitations SET revoked_at = ?
        WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).run(now, invitationId, now);
      if (updated.changes !== 1)
        throw new InvitationError('INVITE_NOT_ACTIVE', 'Invitation is not active');
      const row = services.sqlite.prepare(
        `${invitationSelect} WHERE i.id = ?`,
      ).get(invitationId) as InvitationRow;
      return toInvitation(row, now);
    },

    async register(
      input: RegisterWithInviteRequest,
      userAgent: string,
    ) {
      const passwordHash = await hashPassword(
        input.password,
        services.passwordOptions,
      );
      const normalizedUsername = normalizeUsername(input.username);
      const now = services.now().getTime();
      const tokenHash = hashInviteToken(input.token);
      const userId = randomUUID();
      const transaction = services.sqlite.transaction(() => {
        const invite = services.sqlite.prepare(
          `${invitationSelect} WHERE i.token_hash = ?`,
        ).get(tokenHash) as InvitationRow | undefined;
        if (!invite)
          throw new InvitationError('INVITE_NOT_FOUND', 'Invitation not found');
        const inviteStatus = statusOf(invite, now);
        if (inviteStatus !== 'active') throw errorForStatus(inviteStatus);
        if (services.sqlite.prepare(
          'SELECT 1 FROM users WHERE normalized_username = ?',
        ).get(normalizedUsername)) {
          throw new InvitationError('USERNAME_EXISTS', 'Username already exists');
        }
        services.sqlite.prepare(`
          INSERT INTO users (
            id, singleton_key, username, normalized_username, password_hash,
            role, status, must_change_password, password_changed_at,
            created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, 'user', 'active', false, ?, ?, ?)
        `).run(
          userId,
          input.username,
          normalizedUsername,
          passwordHash,
          now,
          now,
          now,
        );
        insertInitialSettings(services.sqlite, userId, now);
        const consumed = services.sqlite.prepare(`
          UPDATE invitations SET used_at = ?, used_by = ?
          WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at > ?
        `).run(now, userId, invite.id, now);
        if (consumed.changes !== 1)
          throw new InvitationError('INVITE_NOT_ACTIVE', 'Invitation is not active');
        return createSessionRecords(
          services,
          {
            id: userId,
            username: input.username,
            role: 'user',
            must_change_password: 0,
          },
          userAgent,
          now,
        );
      });
      return transaction.immediate();
    },
  };
}

export type InvitationService = ReturnType<typeof createInvitationService>;
export type InvitationDatabase = Database.Database;
