import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/** Workflow / Process Designer definition per tenant and Request Type (SDD Section 19.3). */
@Entity({ name: 'workflow_definitions' })
@Index('uq_workflow_definitions', ['tenantId', 'requestType'], { unique: true })
export class WorkflowDefinition {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(60), name: 'request_type' }) requestType: string;
  @Column({ ...T.text(), name: 'definition_json' }) definitionJson: string;
  @Column({ ...T.bool(), name: 'is_active' }) isActive: boolean;
  @Column({ ...T.int(), name: 'row_version' }) rowVersion: number;
  @Column({ ...T.id(), name: 'updated_by' }) updatedBy: string;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}

@Entity({ name: 'workflow_events' })
@Index('ix_workflow_events_entity', ['tenantId', 'entityId'])
export class WorkflowEvent {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.id(), name: 'entity_id' }) entityId: string;
  @Column({ ...T.str(60), name: 'from_state' }) fromState: string;
  @Column({ ...T.str(60), name: 'to_state' }) toState: string;
  @Column({ ...T.str(60), name: 'action_code' }) actionCode: string;
  @Column({ ...T.id(), name: 'actor_id' }) actorId: string;
  @Column({ ...T.str(200), name: 'actor_name' }) actorName: string;
  @Column({ ...T.str(2000, { nullable: true }), name: 'remarks' }) remarks: string | null;
  @Column({ ...T.ts(), name: 'occurred_at' }) occurredAt: Date;
}
