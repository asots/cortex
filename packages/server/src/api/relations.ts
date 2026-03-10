import type { FastifyInstance } from 'fastify';
import { listRelations as sqliteListRelations, insertRelation, deleteRelation as sqliteDeleteRelation, getRelationEvidence } from '../db/index.js';
import { normalizeEntity } from '../utils/normalize.js';
import * as neo4jDb from '../db/neo4j.js';
import { randomUUID } from 'crypto';

export function registerRelationsRoutes(app: FastifyInstance): void {
  const useNeo4j = !!neo4jDb.getDriver();

  app.get('/api/v1/relations', async (req) => {
    const q = req.query as any;

    if (useNeo4j) {
      return neo4jDb.listRelations({
        agentId: q.agent_id,
        limit: q.limit ? parseInt(q.limit) : undefined,
        includeExpired: q.include_expired === 'true' || q.include_expired === '1',
      });
    }

    return sqliteListRelations({
      subject: q.subject,
      object: q.object,
      agent_id: q.agent_id,
      limit: q.limit ? parseInt(q.limit) : undefined,
      include_expired: q.include_expired === 'true' || q.include_expired === '1',
    });
  });

  app.post('/api/v1/relations', {
    schema: {
      body: {
        type: 'object',
        required: ['subject', 'predicate', 'object'],
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          confidence: { type: 'number' },
          source_memory_id: { type: 'string' },
          agent_id: { type: 'string' },
          source: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as any;
    const rel = {
      id: randomUUID(),
      subject: normalizeEntity(body.subject),
      predicate: body.predicate,
      object: normalizeEntity(body.object),
      confidence: body.confidence ?? 0.8,
      source_memory_id: body.source_memory_id || undefined,
      agent_id: body.agent_id || 'default',
      source: body.source || 'manual',
      extraction_count: 1,
      expired: 0,
    };

    if (useNeo4j) {
      await neo4jDb.upsertRelation(rel);
      reply.code(201);
      return { ...rel, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    }

    const result = insertRelation(rel);
    reply.code(201);
    return result;
  });

  // Graph traversal endpoint (Neo4j only)
  app.get('/api/v1/relations/traverse', async (req) => {
    const q = req.query as any;
    if (!useNeo4j) {
      return { error: 'Graph traversal requires Neo4j', results: [] };
    }
    return neo4jDb.traverseRelations(q.entity, {
      maxHops: q.hops ? parseInt(q.hops) : 2,
      minConfidence: q.min_confidence ? parseFloat(q.min_confidence) : 0.5,
      limit: q.limit ? parseInt(q.limit) : 30,
      agentId: q.agent_id,
    });
  });

  // Graph stats endpoint
  app.get('/api/v1/relations/stats', async () => {
    if (useNeo4j) {
      return neo4jDb.getGraphStats();
    }
    return { nodes: 0, edges: 0, agents: [] };
  });

  app.get('/api/v1/relations/:id/evidence', async (req, reply) => {
    const { id } = req.params as { id: string };
    const evidence = getRelationEvidence(id);
    return evidence;
  });

  app.delete('/api/v1/relations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    if (useNeo4j) {
      const ok = await neo4jDb.deleteRelation(id);
      if (!ok) { reply.code(404); return { error: 'Relation not found' }; }
      return { ok: true, id };
    }

    const ok = sqliteDeleteRelation(id);
    if (!ok) { reply.code(404); return { error: 'Relation not found' }; }
    return { ok: true, id };
  });
}
