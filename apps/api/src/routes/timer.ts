import {
  CompleteTimerRequestSchema,
  ExitTimerRequestSchema,
  PauseTimerRequestSchema,
  ResumeTimerRequestSchema,
  StartTimerRequestSchema,
  StartTimerResponseSchema,
  TimerFinalizationResponseSchema,
  TimerIdParamsSchema,
  TimerStateResponseSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';
import {
  getAuthenticatedSession,
  requireAuthentication,
} from '../auth/auth-hook';
import type { Services } from '../auth/session-service';
import { createTimerService } from '../services/timer';

export async function timerRoutes(app: FastifyInstance, services: Services) {
  const guard = requireAuthentication(services);
  const timer = createTimerService({
    sqlite: services.sqlite,
    now: services.now,
  });
  const user = (request: Parameters<typeof getAuthenticatedSession>[0]) =>
    getAuthenticatedSession(request).user_id;

  app.get('/api/timer', { preHandler: guard }, async (request) =>
    TimerStateResponseSchema.parse(timer.getActiveTimer(user(request))),
  );
  app.post('/api/timer/start', { preHandler: guard }, async (request) =>
    StartTimerResponseSchema.parse(
      timer.startTimer(
        user(request),
        StartTimerRequestSchema.parse(request.body),
      ),
    ),
  );
  app.post(
    '/api/timer/:timerId/pause',
    { preHandler: guard },
    async (request) => {
      const { timerId } = TimerIdParamsSchema.parse(request.params);
      return TimerStateResponseSchema.parse(
        timer.pauseTimer(
          user(request),
          timerId,
          PauseTimerRequestSchema.parse(request.body),
        ),
      );
    },
  );
  app.post(
    '/api/timer/:timerId/resume',
    { preHandler: guard },
    async (request) => {
      const { timerId } = TimerIdParamsSchema.parse(request.params);
      return TimerStateResponseSchema.parse(
        timer.resumeTimer(
          user(request),
          timerId,
          ResumeTimerRequestSchema.parse(request.body),
        ),
      );
    },
  );
  app.post(
    '/api/timer/:timerId/complete',
    { preHandler: guard },
    async (request) => {
      const { timerId } = TimerIdParamsSchema.parse(request.params);
      return TimerFinalizationResponseSchema.parse(
        timer.completeTimer(
          user(request),
          timerId,
          CompleteTimerRequestSchema.parse(request.body),
        ),
      );
    },
  );
  app.post(
    '/api/timer/:timerId/exit',
    { preHandler: guard },
    async (request) => {
      const { timerId } = TimerIdParamsSchema.parse(request.params);
      return TimerFinalizationResponseSchema.parse(
        timer.exitTimer(
          user(request),
          timerId,
          ExitTimerRequestSchema.parse(request.body),
        ),
      );
    },
  );
}
