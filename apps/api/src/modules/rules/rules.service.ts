import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { RuleDefinition } from './rules.entities';
import { Outcome, Rule, RuleAction, evaluateRules, validateRule } from './rule-evaluator';
import { ConfigurationService, GovernanceService } from '../configuration/configuration.service';
import { visibleScopes, newId } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';
import { ConflictError, DomainError } from '../../common/errors';
import { CORE_SCOPE } from '../../common/db-types';

export function toRule(d: RuleDefinition): Rule {
  return { ruleKey: d.ruleKey, name: d.name, condition: JSON.parse(d.conditionJson), actions: JSON.parse(d.actionsJson) as RuleAction[] };
}

@Injectable()
export class RulesService implements OnModuleInit {
  constructor(private readonly ds: DataSource, private readonly config: ConfigurationService, private readonly governance: GovernanceService) {}

  onModuleInit() {
    this.governance.register('rule', (m, ref, p) => this.applyRule(m, ref, p), async (_m, ref, p) => {
      if (!p.name) throw new DomainError('invalid_rule', 'A rule needs a name');
      validateRule({ ruleKey: ref, name: String(p.name), condition: p.condition, actions: p.actions as RuleAction[] });
    });
  }

  /** Rules in force for this tenant: its own rules, plus core-library rules it has not replaced with a same-key rule. */
  async active(entityType: string, trigger: string, m?: EntityManager): Promise<RuleDefinition[]> {
    const all = await (m ?? this.ds.manager).getRepository(RuleDefinition).find({
      where: { ownerScope: In(visibleScopes()), entityType, triggerOn: trigger as RuleDefinition['triggerOn'] }, order: { ruleKey: 'ASC' } });
    return this.merge(all).filter(r => r.isActive);
  }

  async list(): Promise<(RuleDefinition & { scope: string })[]> {
    const all = await this.ds.getRepository(RuleDefinition).find({ where: { ownerScope: In(visibleScopes()) }, order: { ruleKey: 'ASC' } });
    return this.merge(all).map(r => ({ ...r, scope: r.ownerScope === CORE_SCOPE ? 'core' : 'tenant' }));
  }

  private merge(all: RuleDefinition[]): RuleDefinition[] {
    const byKey = new Map<string, RuleDefinition>();
    for (const r of all) if (r.ownerScope === CORE_SCOPE) byKey.set(r.ruleKey, r);
    for (const r of all) if (r.ownerScope !== CORE_SCOPE) byKey.set(r.ruleKey, r);
    return [...byKey.values()];
  }

  async evaluate(entityType: string, trigger: string, record: Record<string, unknown>, m?: EntityManager): Promise<Outcome> {
    const defs = await this.active(entityType, trigger, m);
    const cfg = await this.config.lookup(m);
    return evaluateRules(defs.map(toRule), k => record[k], cfg);
  }

  /** Try a rule against a sample record without saving it (rule tester in the admin console). */
  async test(rule: Rule, record: Record<string, unknown>): Promise<Outcome> {
    validateRule(rule);
    const cfg = await this.config.lookup();
    return evaluateRules([rule], k => record[k], cfg);
  }

  /** Create or replace a tenant rule (a core rule with the same key is overridden for this tenant). */
  async applyRule(m: EntityManager, ruleKey: string, p: Record<string, unknown>) {
    const rule: Rule = { ruleKey, name: String(p.name ?? ''), condition: p.condition, actions: p.actions as RuleAction[] };
    if (!rule.name) throw new DomainError('invalid_rule', 'A rule needs a name');
    validateRule(rule);
    const repo = m.getRepository(RuleDefinition);
    const tenantId = requireTenant();
    const existing = await repo.findOne({ where: { ownerScope: tenantId, ruleKey } });
    const actor = requireActor();
    const values = { name: rule.name, entityType: String(p.entityType ?? 'credit_request'), triggerOn: (p.triggerOn ?? 'on_save') as RuleDefinition['triggerOn'],
      conditionJson: JSON.stringify(rule.condition), actionsJson: JSON.stringify(rule.actions), isActive: p.isActive !== false,
      updatedBy: actor.userId, updatedAt: new Date() };
    if (existing) {
      if (p.expectedVersion !== undefined && p.expectedVersion !== existing.rowVersion) throw new ConflictError(`Rule "${ruleKey}" was changed by someone else`);
      await repo.update({ id: existing.id, ownerScope: tenantId }, { ...values, rowVersion: existing.rowVersion + 1 });
      return { before: toRule(existing), after: { ...rule, version: existing.rowVersion + 1 } };
    }
    await repo.insert({ id: newId(), ownerScope: tenantId, ruleKey, ...values, rowVersion: 1 });
    return { before: null, after: { ...rule, version: 1 } };
  }
}
