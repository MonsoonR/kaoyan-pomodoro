import type { FastifyInstance } from 'fastify';
export function installOriginGuard(app: FastifyInstance, appOrigin: string) {
  app.addHook('preValidation', async (request, reply) => {
    if (!['POST','PUT','PATCH','DELETE'].includes(request.method)) return;
    if (request.headers.origin !== appOrigin) return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN', message: 'Request origin is not allowed' });
    const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return reply.code(415).send({ code: 'JSON_REQUIRED', message: 'Content-Type must be application/json' });
    }
  });
}
