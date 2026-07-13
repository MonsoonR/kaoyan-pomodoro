import { SyncOperationSchema, type SyncOperation } from '@kaoyan/contracts';
import { describe, expect, it } from 'vitest';
import { dailyTask, NOW, settings, TASK_ID, task } from '../test/fixtures';
import { projectEntity } from './projector';

let operationNumber = 100;
function operation(value: Omit<SyncOperation, 'operationId' | 'createdAt'>) {
  operationNumber += 1;
  return SyncOperationSchema.parse({
    ...value,
    operationId: `00000000-0000-4000-8000-${String(operationNumber).padStart(12, '0')}`,
    createdAt: NOW,
  });
}

describe('optimistic entity projector', () => {
  it('creates a task at local version zero without mutating the operation', () => {
    const create = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'create',
      baseVersion: 0,
      payload: {
        title: 'Calculus', subject: 'Math', defaultPomodoroTarget: 3,
        defaultTimerPreset: '25-5', notes: null,
      },
    });
    const before = structuredClone(create);
    expect(projectEntity(null, [create])).toMatchObject({
      id: TASK_ID, title: 'Calculus', version: 0,
    });
    expect(create).toEqual(before);
  });

  it('patches only fields present and increments projected version', () => {
    const update = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'update',
      baseVersion: 1, payload: { title: 'Vectors' },
    });
    expect(projectEntity(task(), [update])).toMatchObject({
      title: 'Vectors', subject: 'Math', version: 2,
    });
  });

  it('does not increment version for semantic no-ops', () => {
    const update = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'update',
      baseVersion: 1, payload: { title: task().title },
    });
    const archive = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'unarchive',
      baseVersion: 1, payload: {},
    });
    expect(projectEntity(task(), [update, archive])).toMatchObject({ version: 1 });
  });

  it('projects archive and delete deterministically', () => {
    const archive = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'archive',
      baseVersion: 1, payload: {},
    });
    const result = projectEntity(task(), [archive]);
    expect(result).toMatchObject({ archived: true, version: 2 });
    expect(projectEntity(task(), [archive])).toEqual(result);
    const remove = operation({
      entityType: 'task', entityId: TASK_ID, operationType: 'delete',
      baseVersion: 2, payload: {},
    });
    expect(projectEntity(task(), [archive, remove])).toBeNull();
  });

  it('projects daily task completion and restore without duplicate bumps', () => {
    const complete = operation({
      entityType: 'dailyTask', entityId: dailyTask().id,
      operationType: 'complete', baseVersion: 1, payload: {},
    });
    const completed = projectEntity(dailyTask(), [complete]);
    expect(completed).toMatchObject({ status: 'completed', version: 2 });
    expect(projectEntity(completed, [complete])).toMatchObject({ version: 2 });
    const restore = operation({
      entityType: 'dailyTask', entityId: dailyTask().id,
      operationType: 'restore', baseVersion: 2, payload: {},
    });
    expect(projectEntity(completed, [restore])).toMatchObject({
      status: 'pending', completedAt: null, version: 3,
    });
  });

  it('projects settings patches', () => {
    const update = operation({
      entityType: 'settings', entityId: settings().id,
      operationType: 'update', baseVersion: 1,
      payload: { soundEnabled: false },
    });
    expect(projectEntity(settings(), [update])).toMatchObject({
      soundEnabled: false, notificationsEnabled: false, version: 2,
    });
  });
});
