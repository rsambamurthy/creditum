import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/**
 * Append-only, hash-chained audit record (SDD Section 26.2).
 * The application has no update or delete path for this table.
 */
@Entity({ name: 'audit_events' })
@Index('uq_audit_events_seq', ['tenantId', 'seq'], { unique: true })
export class AuditEvent {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.bigint(), name: 'seq' }) seq: number;
  /** ISO-8601 UTC text; the hash is computed over this exact text so it is identical on every engine. */
  @Column({ ...T.str(30), name: 'occurred_at_utc' }) occurredAtUtc: string;
  @Column({ ...T.ts(), name: 'occurred_at' }) occurredAt: Date;
  @Column({ ...T.id(), name: 'actor_id' }) actorId: string;
  @Column({ ...T.str(200), name: 'actor_name' }) actorName: string;
  @Column({ ...T.str(80), name: 'action_code' }) action: string;
  @Column({ ...T.str(80), name: 'entity_type' }) entityType: string;
  @Column({ ...T.str(160), name: 'entity_ref' }) entityRef: string;
  @Column({ ...T.text({ nullable: true }), name: 'before_data' }) beforeData: string | null;
  @Column({ ...T.text({ nullable: true }), name: 'after_data' }) afterData: string | null;
  @Column({ ...T.str(64, { nullable: true }), name: 'client_ip' }) clientIp: string | null;
  @Column({ ...T.str(80, { nullable: true }), name: 'session_ref' }) sessionRef: string | null;
  @Column({ ...T.str(64), name: 'prev_hash' }) prevHash: string;
  @Column({ ...T.str(64), name: 'record_hash' }) hash: string;
}

/** One row per tenant; locked for update while appending so the chain stays strictly sequential. */
@Entity({ name: 'audit_chain_heads' })
export class AuditChainHead {
  @PrimaryColumn({ ...T.pk(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.bigint(), name: 'last_seq' }) lastSeq: number;
  @Column({ ...T.str(64), name: 'last_hash' }) lastHash: string;
}
