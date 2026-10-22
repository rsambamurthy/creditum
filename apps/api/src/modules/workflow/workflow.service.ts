import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { WorkflowDefinition, WorkflowEvent } from './workflow.entities';
import { WfDefinition, validateDefinition } from './workflow-engine';
import { GovernanceService, ConfigurationService } from '../configuration/configuration.service';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';
import { ConflictError, DomainError } from '../../common/errors';

@Injectable()
export class WorkflowService implements OnModuleInit {
  constructor(private readonly ds: DataSource, private readonly governance: GovernanceService, private readonly config: ConfigurationService) {}

  onModuleInit() {
    this.governance.register('workflow', (m, ref, p) => this.applyDefinition(m, ref, p), async (m, ref, p) => {
      await this.config.requireValue('request_type', ref, m);
      validateDefinition(p.definition as WfDefinition);
    });
  }

  async definition(requestType: string, m?: EntityManager): Promise<{ row: WorkflowDefinition; def: WfDefinition }> {
    const row = await (m ?? this.ds.manager).getRepository(WorkflowDefinition)
      .findOne({ where: tenantWhere<WorkflowDefinition>({ requestType, isActive: true }) });
    if (!row) throw new DomainError('config_missing', `No workflow is configured for request type "${requestType}"`);
    return { row, def: JSON.parse(row.definitionJson) as WfDefinition };
  }

  list() { return this.ds.getRepository(WorkflowDefinition).find({ where: tenantWhere<WorkflowDefinition>(), order: { requestType: 'ASC' } }); }

  history(entityId: string) {
    return this.ds.getRepository(WorkflowEvent).find({ where: tenantWhere<WorkflowEvent>({ entityId }), order: { occurredAt: 'ASC' } });
  }

  async record(m: EntityManager, e: Omit<WorkflowEvent, 'id' | 'tenantId' | 'occurredAt'>) {
    await m.getRepository(WorkflowEvent).insert({ id: newId(), tenantId: requireTenant(), occurredAt: new Date(), ...e });
  }

  async applyDefinition(m: EntityManager, requestType: string, p: Record<string, unknown>) {
    await this.config.requireValue('request_type', requestType, m);
    const def = p.definition as WfDefinition;
    validateDefinition(def);
    const repo = m.getRepository(WorkflowDefinition);
    const existing = await repo.findOne({ where: tenantWhere<WorkflowDefinition>({ requestType }) });
    const actor = requireActor();
    if (existing) {
      if (p.expectedVersion !== undefined && p.expectedVersion !== existing.rowVersion) throw new ConflictError(`Workflow for "${requestType}" was changed by someone else`);
      await repo.update(tenantWhere<WorkflowDefinition>({ id: existing.id }), { definitionJson: JSON.stringify(def), rowVersion: existing.rowVersion + 1,
        updatedBy: actor.userId, updatedAt: new Date(), isActive: true });
      return { before: JSON.parse(existing.definitionJson), after: def };
    }
    await repo.insert({ id: newId(), tenantId: requireTenant(), requestType, definitionJson: JSON.stringify(def), isActive: true, rowVersion: 1,
      updatedBy: actor.userId, updatedAt: new Date() });
    return { before: null, after: def };
  }
}
