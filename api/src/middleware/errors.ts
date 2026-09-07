import type { FastifyError, FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;
    request.log.error({ err: error, requestId }, 'request failed');
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const message = statusCode >= 500 ? 'An unexpected error occurred.' : error.message;
    reply.status(statusCode).send({ error: { code: error.code || 'INTERNAL_ERROR', message, requestId } });
  });
}
