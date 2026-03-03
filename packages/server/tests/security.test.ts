import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthMiddleware, registerAgentEnforcement, registerRateLimiting } from '../src/api/security.js';

describe('Security', () => {
  describe('Auth Middleware (master token)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify();
      registerAuthMiddleware(app, { token: 'test-token-123' });
      app.get('/api/v1/health', async () => ({ status: 'ok' }));
      app.get('/api/v1/stats', async () => ({ count: 0 }));
      app.get('/dashboard', async () => 'html');
      await app.ready();
    });

    afterAll(() => app.close());

    it('should allow health check without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
    });

    it('should reject API calls without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
      expect(res.statusCode).toBe(401);
    });

    it('should reject API calls with wrong token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/stats',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should allow API calls with correct token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/stats',
        headers: { authorization: 'Bearer test-token-123' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should allow non-API routes without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('Multi-token agent enforcement', () => {
    let app: FastifyInstance;

    const authConfig = {
      token: 'master-token',
      agents: [
        { agent_id: 'xiaomei', token: 'xiaomei-token' },
        { agent_id: 'bot-bob', token: 'bob-token' },
      ],
    };

    beforeAll(async () => {
      app = Fastify();
      registerAuthMiddleware(app, authConfig);
      registerAgentEnforcement(app, authConfig);
      app.post('/api/v1/recall', async (req) => {
        const body = req.body as any;
        return { agent_id: body.agent_id, query: body.query };
      });
      app.post('/api/v1/ingest', async (req) => {
        const body = req.body as any;
        return { agent_id: body.agent_id };
      });
      await app.ready();
    });

    afterAll(() => app.close());

    it('should allow master token to access any agent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        headers: { authorization: 'Bearer master-token', 'content-type': 'application/json' },
        payload: { query: 'test', agent_id: 'xiaomei' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().agent_id).toBe('xiaomei');
    });

    it('should allow agent token to access its own agent_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        headers: { authorization: 'Bearer xiaomei-token', 'content-type': 'application/json' },
        payload: { query: 'test', agent_id: 'xiaomei' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().agent_id).toBe('xiaomei');
    });

    it('should reject agent token accessing another agent_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        headers: { authorization: 'Bearer xiaomei-token', 'content-type': 'application/json' },
        payload: { query: 'test', agent_id: 'bot-bob' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should auto-inject agent_id when not provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ingest',
        headers: { authorization: 'Bearer bob-token', 'content-type': 'application/json' },
        payload: { user_message: 'hi', assistant_message: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().agent_id).toBe('bot-bob');
    });

    it('should reject unknown tokens', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        headers: { authorization: 'Bearer unknown-token', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Rate Limiting', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify();
      registerRateLimiting(app, { windowMs: 60000, maxRequests: 3 });
      app.get('/api/v1/test', async () => ({ ok: true }));
      await app.ready();
    });

    afterAll(() => app.close());

    it('should allow requests within limit', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/test' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('3');
    });

    it('should block requests exceeding limit', async () => {
      // Already used 1, send 2 more to hit limit
      await app.inject({ method: 'GET', url: '/api/v1/test' });
      await app.inject({ method: 'GET', url: '/api/v1/test' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/test' });
      expect(res.statusCode).toBe(429);
    });
  });
});
