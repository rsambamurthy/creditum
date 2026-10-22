import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditRequest } from './credit-request.entities';
import { ConfigurationService } from '../configuration/configuration.service';
import { RulesService } from '../rules/rules.service';
import { WorkflowService } from '../workflow/workflow.service';
import { FieldRegistryService } from '../field-registry/field-registry.service';
import { AuditService } from '../audit/audit.service';
import { availableTransitions, resolveTransition, TransitionContext, WfDefinition } from '../workflow/workflow-engine';
import { formatRequestNumber, NumberScheme, separatorValue, sequenceScope } from './request-number';
import { dec, isDecimalText, scaleOf, toText } from '../../common/decimal';
import { ConflictError, DomainError, NotFoundError } from '../../common/errors';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';
import { Outcome } from '../rules/rule-evaluator';
import type { FormsService } from '../forms/forms.service';

export interface CreditRequestInput {
  borrowerName: string; borrowerRef: string; requestType: string; requestedAmount: string; currencyCode: string;
  fields?: Record<string, unknown>;
}

export const ENTITY = 'credit_request';

/** The record the rules engine sees: header columns under snake_case names plus record-level field values. */
export function recordView(r: Pick<CreditRequest, 'borrowerName' | 'borrowerRef' | 'requestType' | 'requestedAmount' | 'currencyCode' | 'baseAmount' | 'requiredLevel'>,
                           fields: Record<string, unknown>): Record<string, unknown> {
  return { borrower_name: r.borrowerName, borrower_ref: r.borrowerRef, request_type: r.requestType, requested_amount: r.requestedAmount,
    currency_code: r.currencyCode, base_amount: r.baseAmount, required_level: r.requiredLevel, ...fields };
}

/** Block on rule blocks and on fields a rule requires that are empty. */
export function enforce(outcome: Outcome, record: Record<string, unknown>) {
  if (outcome.blocks.length) throw new DomainError('rule_blocked', outcome.blocks.map(b => b.message).join('; '), undefined, outcome);
  const missing = outcome.required.filter(r => record[r.field] === undefined || record[r.field] === null || record[r.field] === '');
  if (missing.length) throw new DomainError('required_fields', missing.map(r => r.message).join('; '), undefined, { missing, outcome });
}

/** Missing-mandatory check used at submission (implemented by the module-data service, registered at start-up). */
type MandatoryCheck = FormsService['mandatoryCheck'];

@Injectable()
export class CreditRequestService {
  private mandatoryCheck?: MandatoryCheck;
  /** Called by FormsService at start-up so submission can check the module data without a circular dependency. */
  useMandatoryCheck(check: MandatoryCheck) { this.mandatoryCheck = check; }

  constructor(private readonly ds: DataSource, private readonly config: ConfigurationService, private readonly rules: RulesService,
              private readonly workflow: WorkflowService, private readonly registry: FieldRegistryService, private readonly audit: AuditService) {}

  private async scheme(m: EntityManager): Promise<NumberScheme> {
    return {
      prefix: await this.config.text('request_number.prefix', m),
      separator: separatorValue(await this.config.text('request_number.separator', m)),
      padding: await this.config.integer('request_number.padding', m),
      includeYear: await this.config.flag('request_number.include_year', m),
      reset: (await this.config.text('request_number.reset', m)) as NumberScheme['reset'],
    };
  }

  /** Validate amount against the currency's configured scale; derive base amount and required authority level. */
  private async money(m: EntityManager, amount: string, currencyCode: string) {
    if (!isDecimalText(amount)) throw new DomainError('invalid_decimal', 'requestedAmount must be a decimal number sent as text');
    if (!dec(amount).isPositive() || dec(amount).isZero()) throw new DomainError('invalid_amount', 'requestedAmount must be greater than zero');
    const currency = await this.config.currency(currencyCode, m);
    if (scaleOf(amount) > currency.minorUnits) {
      throw new DomainError('amount_scale', `${currency.code} amounts allow at most ${currency.minorUnits} decimal places`);
    }
    const { baseAmount, rate } = await this.config.toBase(amount, currency.code, m);
    const level = await this.config.requiredLevel(baseAmount, m);
    return { requestedAmount: toText(dec(amount)), baseAmount, fxRateUsed: rate, requiredLevel: level.levelCode };
  }

  async create(input: CreditRequestInput) {
    return this.ds.transaction(async m => {
      await this.config.requireValue('request_type', input.requestType, m);
      if (!input.borrowerName?.trim() || !input.borrowerRef?.trim()) throw new DomainError('invalid_value', 'borrowerName and borrowerRef are required');
      const money = await this.money(m, input.requestedAmount, input.currencyCode);
      const { def } = await this.workflow.definition(input.requestType, m);
      const draft = { borrowerName: input.borrowerName.trim(), borrowerRef: input.borrowerRef.trim(), requestType: input.requestType,
        currencyCode: input.currencyCode, ...money };
      const fields = input.fields ?? {};
      const record = recordView(draft, fields);
      const outcome = await this.rules.evaluate(ENTITY, 'on_save', record, m);
      enforce(outcome, record);
      const scheme = await this.scheme(m);
      const year = new Date().getUTCFullYear();
      const seq = await this.config.nextSequence(m, sequenceScope(scheme, year));
      const actor = requireActor();
      const now = new Date();
      const row = m.getRepository(CreditRequest).create({ id: newId(), tenantId: requireTenant(), requestNumber: formatRequestNumber(scheme, year, seq),
        status: def.initial, makerId: actor.userId, createdAt: now, updatedAt: now, rowVersion: 1, ...draft });
      await m.getRepository(CreditRequest).insert(row);
      if (Object.keys(fields).length) await this.registry.saveValues(m, ENTITY, row.id, fields);
      await this.audit.append(m, { action: 'credit_request_created', entityType: ENTITY, entityRef: row.requestNumber, after: { ...recordView(row, fields), status: row.status } });
      return { request: await this.get(row.id, m), warnings: outcome.warnings };
    });
  }

  async update(id: string, expectedVersion: number, input: Partial<CreditRequestInput>) {
    return this.ds.transaction(async m => {
      const current = await this.load(id, m);
      if (current.rowVersion !== expectedVersion) throw new ConflictError('This credit request was changed by someone else — reload to see the latest version', { currentVersion: current.rowVersion });
      const { def } = await this.workflow.definition(current.requestType, m);
      if (!def.states.find(s => s.code === current.status && s.editable)) {
        throw new DomainError('not_editable', `A request in state "${current.status}" cannot be edited`);
      }
      const requestType = input.requestType ?? current.requestType;
      if (input.requestType) await this.config.requireValue('request_type', requestType, m);
      const money = await this.money(m, input.requestedAmount ?? current.requestedAmount, input.currencyCode ?? current.currencyCode);
      const next = { borrowerName: input.borrowerName?.trim() ?? current.borrowerName, borrowerRef: input.borrowerRef?.trim() ?? current.borrowerRef,
        requestType, currencyCode: input.currencyCode ?? current.currencyCode, ...money };
      const existingFields = await this.registry.values(ENTITY, id, m);
      const fields = { ...existingFields, ...(input.fields ?? {}) };
      const record = recordView(next, fields);
      const outcome = await this.rules.evaluate(ENTITY, 'on_save', record, m);
      enforce(outcome, record);
      const res = await m.getRepository(CreditRequest).update(tenantWhere<CreditRequest>({ id, rowVersion: expectedVersion }),
        { ...next, rowVersion: expectedVersion + 1, updatedAt: new Date() });
      if (res.affected === 0) throw new ConflictError('This credit request was changed by someone else — reload to see the latest version');
      if (input.fields) await this.registry.saveValues(m, ENTITY, id, input.fields);
      await this.audit.append(m, { action: 'credit_request_updated', entityType: ENTITY, entityRef: current.requestNumber,
        before: recordView(current, existingFields), after: record });
      return { request: await this.get(id, m), warnings: outcome.warnings };
    });
  }

  private async authorityRoles(m: EntityManager, requiredLevel: string): Promise<string[]> {
    const levels = await this.config.authorityLevels(m);
    const req = levels.find(l => l.levelCode === requiredLevel);
    if (!req) throw new DomainError('config_missing', `Authority level "${requiredLevel}" is no longer configured`);
    return levels.filter(l => l.rankNo >= req.rankNo).map(l => l.approverRole);
  }

  private async transitionContext(m: EntityManager, r: CreditRequest): Promise<TransitionContext> {
    const actor = requireActor();
    return { actorId: actor.userId, actorRoles: actor.roles, makerId: r.makerId, authorityRoles: await this.authorityRoles(m, r.requiredLevel) };
  }

  async transition(id: string, action: string, expectedVersion: number, remarks?: string) {
    return this.ds.transaction(async m => {
      const r = await this.load(id, m);
      if (r.rowVersion !== expectedVersion) throw new ConflictError('This credit request was changed by someone else — reload to see the latest version');
      const { def } = await this.workflow.definition(r.requestType, m);
      const t = resolveTransition(def, r.status, action, await this.transitionContext(m, r), remarks);
      const leavingEditable = def.states.find(s => s.code === r.status)?.editable;
      const warnings: string[] = [];
      if (leavingEditable) {
        const fields = await this.registry.values(ENTITY, id, m);
        const record = recordView(r, fields);
        enforce(await this.rules.evaluate(ENTITY, 'on_submit', record, m), record);
        if (this.mandatoryCheck) {
          const { mode, missing } = await this.mandatoryCheck(id, m);
          if (missing.length && mode === 'block') {
            throw new DomainError('mandatory_fields', `${missing.length} mandatory field(s) are not filled in`, undefined, { missing });
          }
          if (missing.length && mode === 'warn') warnings.push(`${missing.length} mandatory field(s) are not filled in`);
        }
      }
      const res = await m.getRepository(CreditRequest).update(tenantWhere<CreditRequest>({ id, rowVersion: expectedVersion }),
        { status: t.to, rowVersion: expectedVersion + 1, updatedAt: new Date() });
      if (res.affected === 0) throw new ConflictError('This credit request was changed by someone else — reload to see the latest version');
      const actor = requireActor();
      await this.workflow.record(m, { entityId: id, fromState: r.status, toState: t.to, actionCode: t.action, actorId: actor.userId,
        actorName: actor.displayName, remarks: remarks ?? null });
      await this.audit.append(m, { action: `credit_request_${t.action}`, entityType: ENTITY, entityRef: r.requestNumber,
        before: { status: r.status }, after: { status: t.to, remarks: remarks ?? null } });
      return warnings.length ? { ...(await this.get(id, m)), warnings } : this.get(id, m);
    });
  }

  private async load(id: string, m?: EntityManager): Promise<CreditRequest> {
    const r = await (m ?? this.ds.manager).getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!r) throw new NotFoundError('Credit request');
    return r;
  }

  async get(id: string, m?: EntityManager) {
    const mgr = m ?? this.ds.manager;
    const r = await this.load(id, mgr);
    const { def } = await this.workflow.definition(r.requestType, mgr);
    const actions = availableTransitions(def, r.status, await this.transitionContext(mgr, r)).map(t => ({ action: t.action, label: t.label, remarksRequired: !!t.remarksRequired }));
    const state = def.states.find(s => s.code === r.status);
    return { ...r, statusLabel: state?.label ?? r.status, editable: !!state?.editable,
      fields: await this.registry.values(ENTITY, id, mgr), actions };
  }

  async list() {
    const rows = await this.ds.getRepository(CreditRequest).find({ where: tenantWhere<CreditRequest>(), order: { createdAt: 'DESC' }, take: 200 });
    const defs = new Map<string, WfDefinition>();
    const out = [];
    for (const r of rows) {
      if (!defs.has(r.requestType)) defs.set(r.requestType, (await this.workflow.definition(r.requestType)).def);
      out.push({ ...r, statusLabel: defs.get(r.requestType)!.states.find(s => s.code === r.status)?.label ?? r.status });
    }
    return out;
  }
}
