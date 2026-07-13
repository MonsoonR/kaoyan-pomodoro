import type {
  ConflictResolution,
  ConflictType,
  ResolvedConflictResult,
} from '@kaoyan/contracts';

export class EntityNotFoundError extends Error {
  readonly code = 'ENTITY_NOT_FOUND';
  constructor() {
    super('Entity not found');
  }
}

export class StaleVersionError extends Error {
  readonly code = 'STALE_VERSION';
  constructor(readonly currentVersion: number) {
    super('Entity version is stale');
  }
}

export class InvalidConflictResolutionError extends Error {
  readonly code = 'INVALID_CONFLICT_RESOLUTION';
  constructor(
    readonly conflictType: ConflictType,
    readonly resolution: ConflictResolution,
  ) {
    super('Resolution is not valid for this conflict type');
  }
}

export class ConflictAlreadyResolvedError extends Error {
  readonly code = 'CONFLICT_ALREADY_RESOLVED';
  constructor(
    readonly resolution: ConflictResolution,
    readonly resolutionResult: ResolvedConflictResult,
  ) {
    super('Conflict was already resolved differently');
  }
}

export class ConflictResolutionTargetExistsError extends Error {
  readonly code = 'CONFLICT_RESOLUTION_TARGET_EXISTS';
  constructor(readonly entityId: string) {
    super('Conflict resolution target already exists');
  }
}
