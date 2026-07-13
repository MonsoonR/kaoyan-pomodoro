import type {
  Conflict,
  CurrentSession,
  PullChangesResponse,
  PushOperationsResponse,
  SyncOperation,
} from '@kaoyan/contracts';
import type { SyncApiClient, TimedTimerResponse } from '../sync/types';
import { NOW, session } from './fixtures';

type Result<T> = T | Error;

function take<T>(queue: Array<Result<T>>, fallback: T): T {
  const result = queue.shift() ?? fallback;
  if (result instanceof Error) throw result;
  return result;
}

export class FakeApiClient implements SyncApiClient {
  readonly calls: string[] = [];
  readonly pushedBatches: SyncOperation[][] = [];
  readonly sessions: Array<Result<CurrentSession>> = [];
  readonly pushes: Array<Result<PushOperationsResponse>> = [];
  readonly pulls: Array<Result<PullChangesResponse>> = [];
  readonly conflictLists: Array<Result<readonly Conflict[]>> = [];
  readonly timers: Array<Result<TimedTimerResponse>> = [];
  readonly conflictDetails = new Map<string, Result<Conflict>>();

  async getCurrentSession(): Promise<CurrentSession> {
    this.calls.push('session');
    return take(this.sessions, session());
  }

  async pushOperations(
    operations: readonly SyncOperation[],
  ): Promise<PushOperationsResponse> {
    this.calls.push('push');
    this.pushedBatches.push([...operations]);
    return take(this.pushes, { receipts: [], latestCursor: 0 });
  }

  async pullChanges(cursor: number): Promise<PullChangesResponse> {
    this.calls.push(`pull:${cursor}`);
    return take(this.pulls, { changes: [], nextCursor: cursor, hasMore: false });
  }

  async listConflicts(): Promise<readonly Conflict[]> {
    this.calls.push('conflicts');
    return take(this.conflictLists, []);
  }

  async getConflict(conflictId: string): Promise<Conflict> {
    this.calls.push(`conflict:${conflictId}`);
    const result = this.conflictDetails.get(conflictId);
    if (!result) throw new Error('Missing fake conflict');
    if (result instanceof Error) throw result;
    return result;
  }

  async getTimer(): Promise<TimedTimerResponse> {
    this.calls.push('timer');
    return take(this.timers, {
      data: { timer: null, serverTime: NOW },
      requestStartedAt: Date.parse(NOW) - 20,
      requestEndedAt: Date.parse(NOW) + 20,
    });
  }
}
