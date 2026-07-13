import { describe, expect, it } from 'vitest';
import {
  buildResolutionRequest,
  resolutionOptionsFor,
} from './resolution-options';

describe('conflict resolution options', () => {
  it.each([
    ['delete_modify', ['keepServer', 'applyDelete', 'copyAsNew']],
    ['complete_restore', ['complete', 'restore']],
    ['archive_add_today', ['keepArchived', 'addAnyway', 'unarchiveAndAdd']],
  ] as const)('exposes only legal choices for %s', (type, expected) => {
    expect(resolutionOptionsFor(type).map((option) => option.value))
      .toEqual(expected);
  });

  it.each([
    ['keepServer', { resolution: 'keepServer' }],
    ['applyDelete', { resolution: 'applyDelete' }],
    ['complete', { resolution: 'complete' }],
    ['restore', { resolution: 'restore' }],
    ['keepArchived', { resolution: 'keepArchived' }],
    ['addAnyway', { resolution: 'addAnyway' }],
    ['unarchiveAndAdd', { resolution: 'unarchiveAndAdd' }],
  ] as const)('builds the exact %s request', (resolution, expected) => {
    expect(buildResolutionRequest(resolution, () => crypto.randomUUID()))
      .toEqual(expected);
  });

  it('generates one stable UUID for copyAsNew', () => {
    const nextId = 'a0000000-0000-4000-8000-000000000001';
    let calls = 0;
    const request = buildResolutionRequest('copyAsNew', () => {
      calls += 1;
      return nextId;
    });
    expect(request).toEqual({ resolution: 'copyAsNew', newEntityId: nextId });
    expect(calls).toBe(1);
  });
});
