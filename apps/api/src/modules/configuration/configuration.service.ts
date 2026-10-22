import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthorityLevel, ConfigChange, ConfigParameter, FxRate, TenantCurrency, ValueListEntry, SequenceCounter } from './configuration.entities';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../../common/errors';
import { compare, isDecimalText, multiply, ROUNDING_MODES, toText } from '../../common/decimal';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';
import { AuditService } from '../audit/audit.service';

export type ChangeHandler = (m: EntityManager, targetRef: string, payload: Record<string, unknown>) => Promise<{ before: unknown; after: unknown }>;
/** Checks a proposed change without applying it, so an invalid change is rejected at submission, not at approval. */
export type ChangeValidator = (m: EntityManager, targetRef: string, payload: Record<string, unknown>) => Promise<void>;

/** Configuration access. Every business value is read from the tenant's configuration; nothing has a default in code. */
/** Parameters whose value must be one of a fixed set of options (the options are behaviour, not business values). */
const ENUMERATED_PARAMS: Record<string, string[]> = {
  'credit_request.mandatory_fields_on_submit': ['off', 'warn', 'block'],
  'calculation.rounding_mode': Object.keys(ROUNDING_MODES),
};

@Injectable()
export class ConfigurationService {
  constructor(private readonly ds: DataSource) {}

  private repo<T extends object>(e: new () => T, m?: EntityManager) { return (m ?? this.ds.manager).getRepository(e); }

  // ---------------------------------------------------------------- parameters
  async param(key: string, m?: EntityManager): Promise<ConfigParameter> {
    const p = await this.repo(ConfigParameter, m).findOne({ where: tenantWhere<ConfigParameter>({ paramKey: key }) });
    if (!p) throw new DomainError('config_missing', `Configuration parameter "${key}" is not set for this tenant`);
    return p;
  }
  async decimal(key: string, m?: EntityManager): Promise<string> {
    const p = await this.param(key, m); this.assertType(p, 'decimal'); return p.paramValue;
  }
  async integer(key: string, m?: EntityManager): Promise<number> {
    const p = await this.param(key, m); this.assertType(p, 'integer'); return Number(p.paramValue);
  }
  async text(key: string, m?: EntityManager): Promise<string> {
    const p = await this.param(key, m); this.assertType(p, 'text'); return p.paramValue;
  }
  async flag(key: string, m?: EntityManager): Promise<boolean> {
    const p = await this.param(key, m); this.assertType(p, 'boolean'); return p.paramValue === 'true';
  }
  private assertType(p: ConfigParameter, t: ConfigParameter['valueType']) {
    if (p.valueType !== t) throw new DomainError('config_type', `Parameter "${p.paramKey}" is ${p.valueType}, expected ${t}`);
  }
  /** Lookup used by the rules engine: returns the raw typed value of any parameter. */
  async lookup(m?: EntityManager): Promise<(key: string) => string | boolean> {
    const all = await this.repo(ConfigParameter, m).find({ where: tenantWhere<ConfigParameter>() });
    const map = new Map(all.map(p => [p.paramKey, p.valueType === 'boolean' ? p.paramValue === 'true' : p.paramValue] as const));
    return (key: string) => {
      if (!map.has(key)) throw new DomainError('config_missing', `Configuration parameter "${key}" referenced by a rule is not set`);
      return map.get(key)!;
    };
  }
  listParams() { return this.repo(ConfigParameter).find({ where: tenantWhere<ConfigParameter>(), order: { paramKey: 'ASC' } }); }

  validateParamValue(valueType: string, value: string, key?: string) {
    const allowed = key ? ENUMERATED_PARAMS[key] : undefined;
    if (allowed && !allowed.includes(value)) throw new DomainError('invalid_value', `"${key}" must be one of ${allowed.join(', ')}`);
    const ok = valueType === 'decimal' ? isDecimalText(value)
      : valueType === 'integer' ? /^-?\d+$/.test(value)
        : valueType === 'boolean' ? value === 'true' || value === 'false'
          : valueType === 'currency' ? /^[A-Z]{3}$/.test(value)
            : valueType === 'text';
    if (!ok) throw new DomainError('invalid_value', `"${value}" is not a valid ${valueType} value`);
  }

  async validateParam(m: EntityManager, key: string, payload: Record<string, unknown>) {
    const existing = await this.repo(ConfigParameter, m).findOne({ where: tenantWhere<ConfigParameter>({ paramKey: key }) });
    const valueType = existing?.valueType ?? (payload.valueType as string | undefined);
    if (!valueType) throw new DomainError('invalid_value', 'valueType is required for a new parameter');
    this.validateParamValue(valueType, String(payload.value), key);
    if (valueType === 'currency') await this.currency(String(payload.value), m);
  }

  /** Apply a parameter change (called by governance, inside its transaction). */
  async applyParam(m: EntityManager, key: string, payload: Record<string, unknown>) {
    const repo = this.repo(ConfigParameter, m);
    const value = String(payload.value);
    const existing = await repo.findOne({ where: tenantWhere<ConfigParameter>({ paramKey: key }) });
    const valueType = (existing?.valueType ?? payload.valueType) as ConfigParameter['valueType'];
    if (!valueType) throw new DomainError('invalid_value', 'valueType is required for a new parameter');
    this.validateParamValue(valueType, value, key);
    if (valueType === 'currency') await this.currency(value, m);
    const actor = requireActor();
    if (existing) {
      if (payload.expectedVersion !== undefined && payload.expectedVersion !== existing.rowVersion) {
        throw new ConflictError(`Parameter "${key}" was changed by someone else`, { currentVersion: existing.rowVersion });
      }
      const before = { value: existing.paramValue, version: existing.rowVersion };
      await repo.update(tenantWhere<ConfigParameter>({ id: existing.id }), { paramValue: value, rowVersion: existing.rowVersion + 1, updatedBy: actor.userId, updatedAt: new Date() });
      return { before, after: { value, version: existing.rowVersion + 1 } };
    }
    await repo.insert({ id: newId(), tenantId: requireTenant(), paramKey: key, valueType, paramValue: value, description: (payload.description as string) ?? null,
      rowVersion: 1, updatedBy: actor.userId, updatedAt: new Date() });
    return { before: null, after: { value, valueType, version: 1 } };
  }

  // ---------------------------------------------------------------- currencies & FX
  listCurrencies() { return this.repo(TenantCurrency).find({ where: tenantWhere<TenantCurrency>(), order: { code: 'ASC' } }); }
  async currency(code: string, m?: EntityManager): Promise<TenantCurrency> {
    const c = await this.repo(TenantCurrency, m).findOne({ where: tenantWhere<TenantCurrency>({ code, isActive: true }) });
    if (!c) throw new DomainError('currency_not_enabled', `Currency "${code}" is not enabled for this tenant`);
    return c;
  }
  async baseCurrency(m?: EntityManager): Promise<TenantCurrency> {
    const c = await this.repo(TenantCurrency, m).findOne({ where: tenantWhere<TenantCurrency>({ isBase: true, isActive: true }) });
    if (!c) throw new DomainError('config_missing', 'No base currency is configured for this tenant');
    return c;
  }
  /** Latest configured rate from -> to. The identity rate is the only rate not read from configuration. */
  async rate(from: string, to: string, m?: EntityManager): Promise<string> {
    if (from === to) return '1';
    const r = await this.repo(FxRate, m).findOne({ where: tenantWhere<FxRate>({ fromCode: from, toCode: to }), order: { asOf: 'DESC' } });
    if (!r) throw new DomainError('fx_rate_missing', `No exchange rate configured from ${from} to ${to}`);
    return r.rate;
  }
  async toBase(amount: string, currencyCode: string, m?: EntityManager): Promise<{ baseAmount: string; rate: string; baseCode: string }> {
    const base = await this.baseCurrency(m);
    const rate = await this.rate(currencyCode, base.code, m);
    return { baseAmount: toText(multiply(amount, rate)), rate, baseCode: base.code };
  }

  // ---------------------------------------------------------------- value lists
  valueList(listKey: string) {
    return this.repo(ValueListEntry).find({ where: tenantWhere<ValueListEntry>({ listKey, isActive: true }), order: { sortOrder: 'ASC' } });
  }
  async listKeys(): Promise<string[]> {
    const rows = await this.repo(ValueListEntry).find({ where: tenantWhere<ValueListEntry>(), select: { listKey: true } });
    return [...new Set(rows.map(r => r.listKey))].sort();
  }
  /** Every entry of a list, including retired ones (administration). */
  allEntries(listKey: string) {
    return this.repo(ValueListEntry).find({ where: tenantWhere<ValueListEntry>({ listKey }), order: { sortOrder: 'ASC' } });
  }

  /**
   * A value list is changed as a whole: the entries sent, in order. Codes are permanent (stored on credit
   * requests), so an entry is never deleted — leaving it out or sending active=false retires it.
   */
  async validateValueList(m: EntityManager, listKey: string, p: Record<string, unknown>) {
    const labelMax = Number(m.connection.getMetadata(ValueListEntry).findColumnWithPropertyName('label')!.length);
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(listKey)) throw new DomainError('invalid_value', 'List keys use lower-case letters, digits and "_"');
    const entries = p.entries;
    if (!Array.isArray(entries) || entries.length === 0) throw new DomainError('invalid_value', 'A value list needs at least one entry');
    const codes = new Set<string>();
    // codes already stored stay valid as they are; new codes use a plain identifier form
    const known = new Set((await this.repo(ValueListEntry, m).find({ where: tenantWhere<ValueListEntry>({ listKey }) })).map(e => e.code));
    for (const e of entries as Record<string, unknown>[]) {
      const code = String(e?.code ?? '');
      if (!known.has(code) && !/^[A-Za-z0-9][A-Za-z0-9_.\-]{0,79}$/.test(code)) throw new DomainError('invalid_value', `"${code}" is not a valid code (letters, digits, "_", "-", ".")`);
      if (codes.has(code)) throw new DomainError('invalid_value', `Code "${code}" appears twice`);
      codes.add(code);
      const label = typeof e.label === 'string' ? e.label.trim() : '';
      if (!label || label.length > labelMax) throw new DomainError('invalid_value', `Entry "${code}" needs a label of up to ${labelMax} characters`);
    }
    if (!(entries as { active?: unknown }[]).some(e => e.active !== false)) throw new DomainError('invalid_value', 'At least one entry must stay active');
  }

  async applyValueList(m: EntityManager, listKey: string, p: Record<string, unknown>) {
    await this.validateValueList(m, listKey, p);
    const repo = this.repo(ValueListEntry, m);
    const existing = await repo.find({ where: tenantWhere<ValueListEntry>({ listKey }), order: { sortOrder: 'ASC' } });
    const byCode = new Map(existing.map(e => [e.code, e]));
    const sent = (p.entries as { code: string; label: string; active?: boolean }[]).map(e => ({ code: String(e.code), label: e.label.trim(), active: e.active !== false }));
    const sentCodes = new Set(sent.map(e => e.code));
    let order = 0;
    for (const e of sent) {
      order += 1;
      const cur = byCode.get(e.code);
      if (cur) await repo.update(tenantWhere<ValueListEntry>({ id: cur.id }), { label: e.label, isActive: e.active, sortOrder: order });
      else await repo.insert({ id: newId(), tenantId: requireTenant(), listKey, code: e.code, label: e.label, sortOrder: order, isActive: e.active });
    }
    for (const cur of existing.filter(x => !sentCodes.has(x.code))) {
      order += 1;
      await repo.update(tenantWhere<ValueListEntry>({ id: cur.id }), { isActive: false, sortOrder: order });
    }
    const view = (list: { code: string; label: string; isActive?: boolean; active?: boolean }[]) =>
      list.map(e => ({ code: e.code, label: e.label, active: e.isActive ?? e.active }));
    return { before: view(existing), after: view(sent) };
  }

  async requireValue(listKey: string, code: string, m?: EntityManager): Promise<ValueListEntry> {
    const v = await this.repo(ValueListEntry, m).findOne({ where: tenantWhere<ValueListEntry>({ listKey, code, isActive: true }) });
    if (!v) throw new DomainError('invalid_code', `"${code}" is not a valid value in list "${listKey}"`);
    return v;
  }

  // ---------------------------------------------------------------- delegated authority
  authorityLevels(m?: EntityManager) { return this.repo(AuthorityLevel, m).find({ where: tenantWhere<AuthorityLevel>(), order: { rankNo: 'ASC' } }); }
  /** Lowest-ranked level whose limit covers the amount (in base currency); a level without a limit is unlimited. */
  async requiredLevel(baseAmount: string, m?: EntityManager): Promise<AuthorityLevel> {
    const levels = await this.authorityLevels(m);
    if (levels.length === 0) throw new DomainError('config_missing', 'No delegated authority levels are configured');
    const lvl = levels.find(l => l.maxAmount === null || compare(baseAmount, l.maxAmount) <= 0);
    if (!lvl) throw new DomainError('no_authority', `No authority level covers ${baseAmount}`);
    return lvl;
  }

  // ---------------------------------------------------------------- sequences
  /** Atomically take the next value of a per-tenant counter (row lock; portable across engines). */
  async nextSequence(m: EntityManager, scopeKey: string): Promise<number> {
    const repo = this.repo(SequenceCounter, m);
    let row = await repo.findOne({ where: tenantWhere<SequenceCounter>({ scopeKey }), lock: { mode: 'pessimistic_write' } });
    if (!row) {
      try {
        await repo.insert({ id: newId(), tenantId: requireTenant(), scopeKey, nextValue: 1 });
      } catch { /* created concurrently by another transaction — fall through and lock it */ }
      row = await repo.findOne({ where: tenantWhere<SequenceCounter>({ scopeKey }), lock: { mode: 'pessimistic_write' } });
      if (!row) throw new Error('Sequence counter could not be created');
    }
    const value = row.nextValue;
    await repo.update(tenantWhere<SequenceCounter>({ id: row.id }), { nextValue: value + 1 });
    return value;
  }
}

/**
 * Configuration change governance: when the tenant's 'governance.config_maker_checker' flag is on,
 * changes wait for a second configuration administrator; otherwise they apply immediately.
 * Either way, every change is audited with before and after values.
 */
@Injectable()
export class GovernanceService {
  private handlers = new Map<string, ChangeHandler>();
  private validators = new Map<string, ChangeValidator>();
  constructor(private readonly ds: DataSource, private readonly config: ConfigurationService, private readonly audit: AuditService) {
    this.register('parameter', (m, ref, p) => this.config.applyParam(m, ref, p), (m, ref, p) => this.config.validateParam(m, ref, p));
    this.register('value_list', (m, ref, p) => this.config.applyValueList(m, ref, p), (m, ref, p) => this.config.validateValueList(m, ref, p));
  }
  register(targetType: string, handler: ChangeHandler, validator: ChangeValidator) {
    this.handlers.set(targetType, handler); this.validators.set(targetType, validator);
  }

  async submit(targetType: string, targetRef: string, payload: Record<string, unknown>) {
    const handler = this.handlers.get(targetType);
    if (!handler) throw new DomainError('invalid_target', `Unknown configuration target "${targetType}"`);
    return this.ds.transaction(async m => {
      await this.validators.get(targetType)!(m, targetRef, payload);
      const makerChecker = await this.config.flag('governance.config_maker_checker', m);
      const actor = requireActor();
      if (makerChecker) {
        const change = this.ds.getRepository(ConfigChange).create({ id: newId(), tenantId: requireTenant(), targetType, targetRef, payload: JSON.stringify(payload),
          status: 'pending', makerId: actor.userId, checkerId: null, decisionNote: null, createdAt: new Date(), decidedAt: null });
        await m.getRepository(ConfigChange).insert(change);
        await this.audit.append(m, { action: 'config_change_submitted', entityType: targetType, entityRef: targetRef, after: payload });
        return { status: 'pending' as const, changeId: change.id };
      }
      const { before, after } = await handler(m, targetRef, payload);
      await this.audit.append(m, { action: 'config_changed', entityType: targetType, entityRef: targetRef, before, after });
      return { status: 'applied' as const };
    });
  }

  pending() { return this.ds.getRepository(ConfigChange).find({ where: tenantWhere<ConfigChange>({ status: 'pending' }), order: { createdAt: 'ASC' } }); }

  async decide(changeId: string, approve: boolean, note: string | undefined) {
    return this.ds.transaction(async m => {
      const repo = m.getRepository(ConfigChange);
      const change = await repo.findOne({ where: tenantWhere<ConfigChange>({ id: changeId }), lock: { mode: 'pessimistic_write' } });
      if (!change) throw new NotFoundError('Configuration change');
      if (change.status !== 'pending') throw new ConflictError('This change has already been decided');
      const actor = requireActor();
      if (change.makerId === actor.userId) throw new ForbiddenError('The maker of a configuration change cannot approve or reject it');
      let result: { before: unknown; after: unknown } | undefined;
      if (approve) {
        const handler = this.handlers.get(change.targetType);
        if (!handler) throw new DomainError('invalid_target', `Unknown configuration target "${change.targetType}"`);
        result = await handler(m, change.targetRef, JSON.parse(change.payload));
      }
      await repo.update(tenantWhere<ConfigChange>({ id: change.id }), { status: approve ? 'applied' : 'rejected', checkerId: actor.userId,
        decisionNote: note ?? null, decidedAt: new Date() });
      await this.audit.append(m, { action: approve ? 'config_change_approved' : 'config_change_rejected', entityType: change.targetType,
        entityRef: change.targetRef, before: result?.before, after: result?.after ?? JSON.parse(change.payload) });
      return { status: approve ? 'applied' : 'rejected' };
    });
  }
}
