import type { FastifyInstance } from 'fastify';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function installOriginGuard(app: FastifyInstance, appOrigin: string) {
  app.addHook('preValidation', async (request, reply) => {
    if (!WRITE_METHODS.has(request.method)) return;
    if (request.headers.origin !== appOrigin) {
      return reply.code(403).send({
        code: 'ORIGIN_FORBIDDEN',
        message: 'Request origin is not allowed',
      });
    }
    const contentType = request.headers['content-type']
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return reply.code(415).send({
        code: 'JSON_REQUIRED',
        message: 'Content-Type must be application/json',
      });
    }
  });
}
