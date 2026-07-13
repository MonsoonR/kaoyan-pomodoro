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
  constructor() { super('RATE_LIMITED', 'Synchronization is temporarily rate limited'); }
}
export class PayloadTooLargeError extends SyncClientError {
  constructor() { super('PAYLOAD_TOO_LARGE', 'The synchronization batch is too large'); }
}
export class ServerError extends SyncClientError {
  constructor() { super('SERVER_ERROR', 'The synchronization service is unavailable'); }
}
export class NetworkError extends SyncClientError {
  constructor() { super('NETWORK_ERROR', 'The network request failed'); }
}
export class ProtocolError extends SyncClientError {
  constructor(message = 'The server response did not match the sync protocol') {
    super('PROTOCOL_ERROR', message);
  }
}
