import type { FastifyInstance } from 'fastify';
import { PaymentConfirmationError, type PaymentConfirmationService } from '../modules/appointments/payment-confirmation.js';

/** Isolated provider ingress: raw bytes are authenticated before parsing. */
export async function registerRazorpayWebhookRoutes(app: FastifyInstance, dependencies: { confirmation: PaymentConfirmationService }): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.post('/v1/providers/razorpay/webhook', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : '';
    const signature = typeof request.headers['x-razorpay-signature'] === 'string' ? request.headers['x-razorpay-signature'] : undefined;
    const eventId = typeof request.headers['x-razorpay-event-id'] === 'string' ? request.headers['x-razorpay-event-id'] : undefined;
    try { return reply.code(200).send(await dependencies.confirmation.receiveRazorpayWebhook(raw, signature, eventId)); }
    catch (error) {
      if (error instanceof PaymentConfirmationError) return reply.code(error.code === 'INVALID_SIGNATURE' ? 401 : 400).send({ error: { code: error.code, message: 'Provider event rejected.' } });
      throw error;
    }
  });
}
