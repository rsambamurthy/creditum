import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { context, requireActor, requireTenant } from '../../common/request-context';
import { newId, tenantWhere } from '../../common/tenant';
import { AuditChainHead, AuditEvent } from './audit.entities';

export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: object keys sorted at every level, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface ChainFields {
  tenantId: string; seq: number; occurredAtUtc: string; actorId: string; actorName: string; action: string;
  entityType: string; entityRef: string; beforeData: string | null; afterData: string | null;
  clientIp: string | null; sessionRef: string | null; prevHash: string;
}

export function recordHash(f: ChainFields): string {
  return createHash('sha256').update(canonicalJson(f)).digest('hex');
}

export interface AuditInput { action: string; entityType: string; entityRef: string; before?: unknown; after?: unknown }

@Injectable()
export class AuditService {
  constructor(private readonly ds: DataSource) {}

  /** Create the chain head for a new tenant (inside the tenant-creation transaction). */
  async initChain(m: EntityManager, tenantId: string): Promise<void> {
    await m.getRepository(AuditChainHead).insert({ tenantId, lastSeq: 0, lastHash: GENESIS_HASH });
  }

  /**
   * Append an audit record in the caller's transaction, so the business change and its audit
   * record commit or roll back together. The chain head is row-locked to keep sequence and hash order strict.
   */
  async append(m: EntityManager, input: AuditInput): Promise<AuditEvent> {
    const tenantId = requireTenant();
    const actor = requireActor();
    const ctx = context();
    const head = await m.getRepository(AuditChainHead).findOne({ where: tenantWhere<AuditChainHead>(), lock: { mode: 'pessimistic_write' } });
    if (!head) throw new Error('Audit chain not initialised for tenant');
    const now = new Date();
    const fields: ChainFields = {
      tenantId, seq: head.lastSeq + 1, occurredAtUtc: now.toISOString(), actorId: actor.userId, actorName: actor.displayName,
      action: input.action, entityType: input.entityType, entityRef: input.entityRef,
      beforeData: input.before === undefined ? null : canonicalJson(input.before),
      afterData: input.after === undefined ? null : canonicalJson(input.after),
      clientIp: ctx.ip ?? null, sessionRef: ctx.sessionId ?? null, prevHash: head.lastHash,
    };
    const hash = recordHash(fields);
    const event = m.getRepository(AuditEvent).create({ id: newId(), ...fields, occurredAt: now, hash });
    await m.getRepository(AuditEvent).insert(event);
    await m.getRepository(AuditChainHead).update(tenantWhere<AuditChainHead>(), { lastSeq: fields.seq, lastHash: hash });
    return event;
  }

  async list(pageSize: number, beforeSeq?: number): Promise<AuditEvent[]> {
    const qb = this.ds.getRepository(AuditEvent).createQueryBuilder('a').where('a.tenantId = :t', { t: requireTenant() });
    if (beforeSeq !== undefined) qb.andWhere('a.seq < :s', { s: beforeSeq });
    return qb.orderBy('a.seq', 'DESC').take(pageSize).getMany();
  }

  /** Recompute every hash in sequence; report the first break, if any. */
  async verify(): Promise<{ valid: boolean; checked: number; brokenAtSeq?: number; reason?: string }> {
    const events = await this.ds.getRepository(AuditEvent).find({ where: tenantWhere<AuditEvent>(), order: { seq: 'ASC' } });
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const e of events) {
      if (e.seq !== expectedSeq) return { valid: false, checked: expectedSeq - 1, brokenAtSeq: e.seq, reason: 'sequence gap' };
      if (e.prevHash !== prev) return { valid: false, checked: expectedSeq - 1, brokenAtSeq: e.seq, reason: 'previous-hash mismatch' };
      const recomputed = recordHash({
        tenantId: e.tenantId, seq: e.seq, occurredAtUtc: e.occurredAtUtc, actorId: e.actorId, actorName: e.actorName, action: e.action,
        entityType: e.entityType, entityRef: e.entityRef, beforeData: e.beforeData, afterData: e.afterData, clientIp: e.clientIp,
        sessionRef: e.sessionRef, prevHash: e.prevHash,
      });
      if (recomputed !== e.hash) return { valid: false, checked: expectedSeq - 1, brokenAtSeq: e.seq, reason: 'record content altered' };
      prev = e.hash;
      expectedSeq += 1;
    }
    const head = await this.ds.getRepository(AuditChainHead).findOne({ where: tenantWhere<AuditChainHead>() });
    if (head && (head.lastSeq !== events.length || head.lastHash !== prev)) {
      return { valid: false, checked: events.length, reason: 'chain head does not match the last record (records removed)' };
    }
    return { valid: true, checked: events.length };
  }
}
