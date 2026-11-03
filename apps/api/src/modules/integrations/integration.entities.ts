import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/** One pull from, or booking into, an external system for a Credit Request — kept for the request's provenance and the audit. */
@Entity({ name: 'integration_runs' })
@Index('ix_integration_runs_entity', ['tenantId', 'entityType', 'entityId', 'connector'])
export class IntegrationRun {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(60), name: 'entity_type' }) entityType: string;
  @Column({ ...T.id(), name: 'entity_id' }) entityId: string;
  @Column({ ...T.str(40) }) connector: string;
  /** pull | booking */
  @Column({ ...T.str(20) }) direction: string;
  /** succeeded | failed */
  @Column({ ...T.str(20) }) status: string;
  /** create | refresh | booking */
  @Column({ ...T.str(40), name: 'trigger_name' }) triggerName: string;
  /** Record-level fields the pull filled (JSON list), which are then read-only on the request. */
  @Column({ ...T.text({ nullable: true }), name: 'record_fields' }) recordFields: string | null;
  @Column({ ...T.text({ nullable: true }), name: 'summary_json' }) summaryJson: string | null;
  @Column({ ...T.str(1000, { nullable: true }) }) message: string | null;
  @Column({ ...T.id(), name: 'actor_id' }) actorId: string;
  @Column({ ...T.ts(), name: 'started_at' }) startedAt: Date;
  @Column({ ...T.ts(), name: 'finished_at' }) finishedAt: Date;
}
