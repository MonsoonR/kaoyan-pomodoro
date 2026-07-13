export class SyncClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends SyncClientError {
  constructor() { super('AUTH_REQUIRED', 'Authentication is required'); }
}
export class ForbiddenError extends SyncClientError {
  constructor() { super('FORBIDDEN', 'The request is not permitted'); }
}
export class RateLimitedError extends SyncClientError {
  constructor(message = 'Synchronization is temporarily rate limited') {
    super('RATE_LIMITED', message);
  }
}
export class PayloadTooLargeError extends SyncClientError {
  constructor() { super('PAYLOAD_TOO_LARGE', 'The synchronization batch is too large'); }
}
export class ServerError extends SyncClientError {
  constructor(message = 'The synchronization service is unavailable') {
    super('SERVER_ERROR', message);
  }
}
export class NetworkError extends SyncClientError {
  constructor() { super('NETWORK_ERROR', 'The network request failed'); }
}
export class ProtocolError extends SyncClientError {
  constructor(message = 'The server response did not match the sync protocol') {
    super('PROTOCOL_ERROR', message);
  }
}
