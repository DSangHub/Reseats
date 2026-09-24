import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, one } from '../db/index.js';
import { badRequest } from '../lib/errors.js';

const signupSchema = z.object({
  business_name: z.string().trim().min(2).max(200),
  contact_name: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(30),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().length(2),
  pos_provider: z.string().trim().min(2).max(100),
  locations: z.number().int().min(1).max(10000).default(1),
  message: z.string().trim().max(2000).optional(),
  website: z.string().max(200).optional(),
});

export async function merchantSignupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/merchant-signups', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw badRequest('invalid_parameter', first?.message ?? 'Check the signup form.', first?.path.join('.'));
    }
    const input = parsed.data;
    // Hidden field catches basic form bots without storing their submissions.
    if (input.website) {
      reply.code(202);
      return { status: 'received' };
    }
    const created = await one<{ id: string }>(db,
      `insert into merchant_signups
        (business_name, contact_name, email, phone, city, state, pos_provider, locations, message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [input.business_name, input.contact_name, input.email.toLowerCase(), input.phone,
       input.city, input.state.toUpperCase(), input.pos_provider, input.locations, input.message ?? null],
    );
    if (!created) throw new Error('Could not save merchant signup.');
    reply.code(201);
    return { id: created.id, status: 'received' };
  });
}
