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
