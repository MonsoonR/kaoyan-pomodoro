import {
  AddToTodayRequestSchema,
  CompleteDailyTaskRequestSchema,
  CreateDailyTaskRequestSchema,
  CreateTaskRequestSchema,
  DailyTaskDateQuerySchema,
  DailyTaskIdParamsSchema,
  DailyTaskListResponseSchema,
  DailyTaskSchema,
  RestoreDailyTaskRequestSchema,
  SettingsSchema,
  TaskIdParamsSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateDailyTaskRequestSchema,
  UpdateSettingsRequestSchema,
  UpdateTaskRequestSchema,
  VersionedMutationRequestSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';
import {
  getAuthenticatedSession,
  requireAuthentication,
} from '../auth/auth-hook';
import type { Services } from '../auth/session-service';
import { createDailyTaskService } from '../services/daily-tasks';
import { createSettingsService } from '../services/settings';
import { createTaskService } from '../services/tasks';

export async function studyDataRoutes(
  app: FastifyInstance,
  services: Services,
) {
  const guard = requireAuthentication(services);
  const deps = { sqlite: services.sqlite, now: services.now };
  const tasks = createTaskService(deps),
    daily = createDailyTaskService(deps),
    settings = createSettingsService(deps);
  const user = (request: Parameters<typeof getAuthenticatedSession>[0]) =>
    getAuthenticatedSession(request).user_id;
  app.get('/api/tasks', { preHandler: guard }, async (request) =>
    TaskListResponseSchema.parse({
      tasks: tasks.list(
        user(request),
        TaskListQuerySchema.parse(request.query).filter,
      ),
    }),
  );
  app.post('/api/tasks', { preHandler: guard }, async (request) =>
    TaskSchema.parse(
      tasks.create(user(request), CreateTaskRequestSchema.parse(request.body)),
    ),
  );
  app.patch('/api/tasks/:taskId', { preHandler: guard }, async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params);
    return TaskSchema.parse(
      tasks.update(
        user(request),
        taskId,
        UpdateTaskRequestSchema.parse(request.body),
      ),
    );
  });
  app.delete('/api/tasks/:taskId', { preHandler: guard }, async (request) => {
    const { taskId } = TaskIdParamsSchema.parse(request.params);
    const { expectedVersion } = VersionedMutationRequestSchema.parse(
      request.body,
    );
    return TaskSchema.parse(
      tasks.delete(user(request), taskId, expectedVersion),
    );
  });
  for (const [path, value] of [
    ['archive', true],
    ['unarchive', false],
  ] as const)
    app.post(
      `/api/tasks/:taskId/${path}`,
      { preHandler: guard },
      async (request) => {
        const { taskId } = TaskIdParamsSchema.parse(request.params);
        const { expectedVersion } = VersionedMutationRequestSchema.parse(
          request.body,
        );
        return TaskSchema.parse(
          tasks.setArchived(user(request), taskId, expectedVersion, value),
        );
      },
    );
  app.post(
    '/api/tasks/:taskId/add-to-today',
    { preHandler: guard },
    async (request) => {
      const { taskId } = TaskIdParamsSchema.parse(request.params);
      return DailyTaskSchema.parse(
        daily.addFromTask(
          user(request),
          taskId,
          AddToTodayRequestSchema.parse(request.body),
        ),
      );
    },
  );
  app.get('/api/daily-tasks', { preHandler: guard }, async (request) =>
    DailyTaskListResponseSchema.parse({
      dailyTasks: daily.list(
        user(request),
        DailyTaskDateQuerySchema.parse(request.query).date,
      ),
    }),
  );
  app.post('/api/daily-tasks', { preHandler: guard }, async (request) =>
    DailyTaskSchema.parse(
      daily.createTemporary(
        user(request),
        CreateDailyTaskRequestSchema.parse(request.body),
      ),
    ),
  );
  app.patch(
    '/api/daily-tasks/:dailyTaskId',
    { preHandler: guard },
    async (request) => {
      const { dailyTaskId } = DailyTaskIdParamsSchema.parse(request.params);
      return DailyTaskSchema.parse(
        daily.update(
          user(request),
          dailyTaskId,
          UpdateDailyTaskRequestSchema.parse(request.body),
        ),
      );
    },
  );
  app.delete(
    '/api/daily-tasks/:dailyTaskId',
    { preHandler: guard },
    async (request) => {
      const { dailyTaskId } = DailyTaskIdParamsSchema.parse(request.params);
      const { expectedVersion } = VersionedMutationRequestSchema.parse(
        request.body,
      );
      return DailyTaskSchema.parse(
        daily.delete(user(request), dailyTaskId, expectedVersion),
      );
    },
  );
  app.post(
    '/api/daily-tasks/:dailyTaskId/complete',
    { preHandler: guard },
    async (request) => {
      const { dailyTaskId } = DailyTaskIdParamsSchema.parse(request.params);
      return DailyTaskSchema.parse(
        daily.setCompleted(
          user(request),
          dailyTaskId,
          CompleteDailyTaskRequestSchema.parse(request.body).expectedVersion,
          true,
        ),
      );
    },
  );
  app.post(
    '/api/daily-tasks/:dailyTaskId/restore',
    { preHandler: guard },
    async (request) => {
      const { dailyTaskId } = DailyTaskIdParamsSchema.parse(request.params);
      return DailyTaskSchema.parse(
        daily.setCompleted(
          user(request),
          dailyTaskId,
          RestoreDailyTaskRequestSchema.parse(request.body).expectedVersion,
          false,
        ),
      );
    },
  );
  app.get('/api/settings', { preHandler: guard }, async (request) =>
    SettingsSchema.parse(settings.get(user(request))),
  );
  app.patch('/api/settings', { preHandler: guard }, async (request) =>
    SettingsSchema.parse(
      settings.update(
        user(request),
        UpdateSettingsRequestSchema.parse(request.body),
      ),
    ),
  );
}
