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

/** Every field and parameter a rule refers to, for checking references before a rule is accepted. */
export function ruleReferences(rule: Pick<Rule, 'condition' | 'actions'>) {
  const vars = new Set<string>(); const cfgs = new Set<string>();
  const walk = (c: unknown): void => {
    if (!c || typeof c !== 'object') return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    const [[op, a]] = Object.entries(c as Record<string, unknown>);
    if (op === 'var') vars.add(String(a)); else if (op === 'cfg') cfgs.add(String(a)); else walk(a);
  };
  walk(rule.condition);
  const actionFields = new Set((rule.actions ?? []).map(a => a.field).filter((f): f is string => !!f));
  return { vars, cfgs, actionFields };
}

/** Where and when a rule runs. on_save: the contexts being saved ("request" = the New/Edit Credit Request form, or module codes). */
export type RuleTrigger = 'on_save' | 'on_submit' | 'on_action';
export interface RuleContext { trigger: RuleTrigger; contexts: string[] }
export const REQUEST_CONTEXT = 'request';

/** Normalise and check a rule's trigger and scope as sent by an administrator. */
export function ruleTrigger(p: Record<string, unknown>): RuleContext {
  const trigger = (p.triggerOn ?? 'on_save') as RuleTrigger;
  if (!['on_save', 'on_submit', 'on_action'].includes(trigger)) throw new DomainError('invalid_rule', 'When to check must be on_save, on_submit or on_action');
  const raw = p.scope ?? (trigger === 'on_save' ? [REQUEST_CONTEXT] : []);
  if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string' || !x)) throw new DomainError('invalid_rule', 'scope must be a list of names');
  const contexts = [...new Set(raw as string[])];
  if (trigger === 'on_save' && !contexts.length) throw new DomainError('invalid_rule', 'Choose what is being saved: the credit request form and/or modules');
  if (trigger === 'on_action' && !contexts.length) throw new DomainError('invalid_rule', 'Choose the workflow action(s) the rule applies to');
  if (trigger === 'on_submit' && contexts.length) throw new DomainError('invalid_rule', 'A submission rule has no scope');
  return { trigger, contexts };
}

export function ruleContexts(d: RuleDefinition): string[] {
  return d.triggerScope ? (JSON.parse(d.triggerScope) as string[]) : [];
}

type ReferenceCheck = (m: EntityManager, rule: Pick<Rule, 'condition' | 'actions'>, ctx: RuleContext) => Promise<void>;

@Injectable()
export class RulesService implements OnModuleInit {
  private referenceCheck?: ReferenceCheck;
  constructor(private readonly ds: DataSource, private readonly config: ConfigurationService, private readonly governance: GovernanceService) {}
  /** Registered by the module-data service at start-up: rejects rules that name unknown fields or parameters. */
  useReferenceCheck(check: ReferenceCheck) { this.referenceCheck = check; }

  onModuleInit() {
    this.governance.register('rule', (m, ref, p) => this.applyRule(m, ref, p), async (m, ref, p) => {
      if (!p.name) throw new DomainError('invalid_rule', 'A rule needs a name');
      const rule = { ruleKey: ref, name: String(p.name), condition: p.condition, actions: p.actions as RuleAction[] };
      validateRule(rule);
      const ctx = ruleTrigger(p);
      if (this.referenceCheck) await this.referenceCheck(m, rule, ctx);
    });
  }

  /** Rules in force for this tenant: its own rules, plus core-library rules it has not replaced with a same-key rule. */
  async active(entityType: string, trigger: string, m?: EntityManager): Promise<RuleDefinition[]> {
    const all = await (m ?? this.ds.manager).getRepository(RuleDefinition).find({
      where: { ownerScope: In(visibleScopes()), entityType, triggerOn: trigger as RuleDefinition['triggerOn'] }, order: { ruleKey: 'ASC' } });
    return this.merge(all).filter(r => r.isActive);
  }

  async list(): Promise<(RuleDefinition & { scope: string; contexts: string[] })[]> {
    const all = await this.ds.getRepository(RuleDefinition).find({ where: { ownerScope: In(visibleScopes()) }, order: { ruleKey: 'ASC' } });
    return this.merge(all).map(r => ({ ...r, scope: r.ownerScope === CORE_SCOPE ? 'core' : 'tenant', contexts: ruleContexts(r) }));
  }

  /**
   * Rules that apply in a situation: on_save rules whose contexts overlap what is being saved, submission rules,
   * or on_action rules naming the workflow action being taken.
   */
  async evaluateIn(ctx: RuleContext, record: Record<string, unknown>, m?: EntityManager): Promise<Outcome> {
    const defs = (await this.active('credit_request', ctx.trigger, m))
      .filter(d => ctx.trigger === 'on_submit' || ruleContexts(d).some(c => ctx.contexts.includes(c)));
    const cfg = await this.config.lookup(m);
    return evaluateRules(defs.map(toRule), k => record[k], cfg);
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
    const ctx = ruleTrigger(p);
    const values = { name: rule.name, entityType: String(p.entityType ?? 'credit_request'), triggerOn: ctx.trigger,
      triggerScope: ctx.contexts.length ? JSON.stringify(ctx.contexts) : null,
      conditionJson: JSON.stringify(rule.condition), actionsJson: JSON.stringify(rule.actions), isActive: p.isActive !== false,
      updatedBy: actor.userId, updatedAt: new Date() };
    if (existing) {
      if (p.expectedVersion !== undefined && p.expectedVersion !== existing.rowVersion) throw new ConflictError(`Rule "${ruleKey}" was changed by someone else`);
      await repo.update({ id: existing.id, ownerScope: tenantId }, { ...values, rowVersion: existing.rowVersion + 1 });
      return { before: { ...toRule(existing), triggerOn: existing.triggerOn, scope: ruleContexts(existing) },
        after: { ...rule, triggerOn: ctx.trigger, scope: ctx.contexts, version: existing.rowVersion + 1 } };
    }
    await repo.insert({ id: newId(), ownerScope: tenantId, ruleKey, ...values, rowVersion: 1 });
    return { before: null, after: { ...rule, triggerOn: ctx.trigger, scope: ctx.contexts, version: 1 } };
  }
}
