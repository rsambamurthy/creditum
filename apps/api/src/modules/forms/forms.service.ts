/**
 * Credit Request module data (SDD Sections 3–9, 20): the seven module screens, rendered from the layout
 * configuration and stored in the typed value store (ADR 0002). Calculated fields are recomputed on every
 * save by the formula engine; every save is audited in the same transaction.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { FieldFormula, FormLayout, FormRow } from './forms.entities';
import { CompiledFormula, compile, evaluate, FormData, FormulaContext, FormulaDef, GridRow, Value } from './formula-engine';
import { COMPOSITE_PARTS, DISPLAY_ONLY_TYPES, LayoutDocument, LayoutField, PlacedField, placements } from './layout';
import { CreditRequest } from '../credit-request/credit-request.entities';
import { CreditRequestService, ENTITY, enforce, recordView } from '../credit-request/credit-request.service';
import { FieldValue, RECORD_ROW } from '../field-registry/field-registry.entities';
import { EffectiveField, FieldRegistryService } from '../field-registry/field-registry.service';
import { ConfigParameter, FxRate, TenantCurrency, ValueListEntry } from '../configuration/configuration.entities';
import { ConfigurationService, GovernanceService } from '../configuration/configuration.service';
import { RulesService } from '../rules/rules.service';
import { WorkflowService } from '../workflow/workflow.service';
import { AuditService } from '../audit/audit.service';
import { CORE_SCOPE, T } from '../../common/db-types';
import { dec, isDecimalText, multiply, toText } from '../../common/decimal';
import { ConflictError, DomainError, NotFoundError } from '../../common/errors';
import { newId, tenantWhere, visibleScopes } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';

const LAYOUT_KEY = 'credit_request';
const MANDATORY_MODES = ['off', 'warn', 'block'] as const;
export type MandatoryMode = typeof MANDATORY_MODES[number];
// Storage precision of field_values.value_decimal (the T.dec default), not a business value.
const STORED = T.dec();
const STORED_SCALE = Number(STORED.scale);
const MAX_INTEGER_DIGITS = Number(STORED.precision) - STORED_SCALE;
const MAX_TEXT = 20000; // guardrail-allow: input size bound against oversized payloads (operational), not a business limit
const CHUNK = 500; // keeps IN lists well below Oracle's 1000-item limit

type ValueKind = 'text' | 'decimal' | 'date' | 'bool' | 'composite' | 'none';
const KIND: Record<string, ValueKind> = {
  'Text': 'text', 'Rich Text': 'text', 'Text (identifier)': 'text', 'Dropdown': 'text', 'Currency Code': 'text', 'Address (structured)': 'text',
  'Currency Amount': 'decimal', 'Percentage': 'decimal', 'Ratio (decimal)': 'decimal', 'Decimal': 'decimal', 'Integer': 'decimal', 'Integer (days)': 'decimal',
  'Date': 'date', 'Boolean (Yes/No)': 'bool',
};
const INTEGER_TYPES = new Set(['Integer', 'Integer (days)']);

function valueKind(dataType: string): ValueKind {
  if (COMPOSITE_PARTS[dataType]) return 'composite';
  if (DISPLAY_ONLY_TYPES.has(dataType)) return 'none';
  return KIND[dataType] ?? 'text';
}

export interface FieldMeta {
  key: string; label: string; helpText: string | null; dataType: string; valueKind: ValueKind; parts?: string[]; source: string; requirement: string;
  list?: string; bind?: string; display?: string; calc?: { status: string; description: string; note: string | null }; readOnly: boolean;
}

interface Model {
  doc: LayoutDocument;
  placed: Map<string, PlacedField>;
  fields: Map<string, EffectiveField>;
  formulas: Map<string, FieldFormula>;
  compiled: CompiledFormula[];
}

export interface SaveInput { expectedVersion: number; record?: Record<string, unknown>; grids?: Record<string, { rowKey?: string; values: Record<string, unknown> }[]> }

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

@Injectable()
export class FormsService implements OnModuleInit {
  constructor(private readonly ds: DataSource, private readonly registry: FieldRegistryService, private readonly config: ConfigurationService,
              private readonly governance: GovernanceService, private readonly rules: RulesService, private readonly workflow: WorkflowService,
              private readonly audit: AuditService, private readonly requests: CreditRequestService) {}

  onModuleInit() {
    this.requests.useMandatoryCheck((id, m) => this.mandatoryCheck(id, m));
    this.governance.register('formula', (m, ref, p) => this.applyFormula(m, ref, p), (m, ref, p) => this.validateFormula(m, ref, p).then(() => undefined));
  }

  // ---------------------------------------------------------------- model: layout + effective fields + formulas
  private async model(m: EntityManager): Promise<Model> {
    const rows = await m.getRepository(FormLayout).find({ where: { ownerScope: In(visibleScopes()), layoutKey: LAYOUT_KEY } });
    const row = rows.find(r => r.ownerScope !== CORE_SCOPE) ?? rows.find(r => r.ownerScope === CORE_SCOPE);
    if (!row) throw new DomainError('config_missing', 'The Credit Request layout is not installed — run the seed step');
    const doc = JSON.parse(row.definitionJson) as LayoutDocument;
    const fields = new Map((await this.registry.effective(m)).map(f => [f.fieldKey, f]));
    this.placeCustomFields(doc, fields);
    const placed = placements(doc);
    const formulas = await this.effectiveFormulas(m);
    const compiled = compile(this.activeDefs(formulas), k => (placed.has(k) ? placed.get(k)!.grid : undefined));
    return { doc, placed, fields, formulas, compiled };
  }

  /** Tenant custom fields join the section of their module and group (a new section if the group is new). */
  private placeCustomFields(doc: LayoutDocument, fields: Map<string, EffectiveField>) {
    for (const f of fields.values()) {
      if (f.scope !== 'tenant') continue;
      const mod = doc.modules.find(x => x.title === f.module) ?? doc.modules[0];
      let section = mod.sections.find(s => s.title === f.group);
      if (!section) {
        section = { code: `${mod.letter}.x.${f.group.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, title: f.group, kind: 'record', fields: [] };
        mod.sections.push(section);
      }
      section.fields.push({ key: f.fieldKey });
    }
  }

  private async effectiveFormulas(m: EntityManager): Promise<Map<string, FieldFormula>> {
    const all = await m.getRepository(FieldFormula).find({ where: { ownerScope: In(visibleScopes()) } });
    const out = new Map<string, FieldFormula>();
    for (const f of all) if (f.ownerScope === CORE_SCOPE) out.set(f.fieldKey, f);
    for (const f of all) if (f.ownerScope !== CORE_SCOPE) out.set(f.fieldKey, f);
    return out;
  }

  private activeDefs(formulas: Map<string, FieldFormula>): FormulaDef[] {
    return [...formulas.values()].filter(f => f.status === 'active' && f.expressionJson).map(f => ({ field: f.fieldKey, expression: JSON.parse(f.expressionJson as string) }));
  }

  private meta(model: Model, lf: LayoutField): FieldMeta | null {
    const f = model.fields.get(lf.key);
    if (!f || f.hidden) return null;
    const kind = valueKind(f.dataType);
    const formula = model.formulas.get(lf.key);
    const out: FieldMeta = { key: lf.key, label: f.label, helpText: f.helpText, dataType: f.dataType, valueKind: kind, source: f.source,
      requirement: f.requirement, readOnly: !!lf.bind || kind === 'none' || !!formula };
    if (kind === 'composite') out.parts = COMPOSITE_PARTS[f.dataType];
    if (lf.list) out.list = lf.list;
    if (lf.bind) out.bind = lf.bind;
    if (lf.display) out.display = lf.display;
    if (formula) out.calc = { status: formula.status, description: formula.description, note: formula.note };
    return out;
  }

  // ---------------------------------------------------------------- GET /layout
  async layout() {
    const m = this.ds.manager;
    const model = await this.model(m);
    const lists = await this.lists(m);
    const currencies = await m.getRepository(TenantCurrency).find({ where: tenantWhere<TenantCurrency>({ isActive: true }), order: { code: 'ASC' } });
    const used = new Set<string>();
    const modules = model.doc.modules.map(mod => ({
      code: mod.code, letter: mod.letter, title: mod.title,
      sections: mod.sections.map(s => {
        const fields = s.fields.map(f => this.meta(model, f)).filter((x): x is FieldMeta => !!x);
        const columns = (s.columns ?? []).map(f => this.meta(model, f)).filter((x): x is FieldMeta => !!x);
        [...fields, ...columns].forEach(f => f.list && used.add(f.list));
        return { code: s.code, title: s.title, kind: s.kind, grid: s.grid ?? null, rowLabel: s.rowLabel ?? null, fields, columns };
      }).filter(s => s.fields.length || s.columns.length),
    }));
    return {
      version: model.doc.version, baseCurrency: currencies.find(c => c.isBase)?.code ?? null,
      currencies: currencies.map(c => ({ code: c.code, minorUnits: c.minorUnits })), grids: model.doc.grids,
      lists: Object.fromEntries([...used].filter(k => lists.has(k)).sort().map(k => [k, lists.get(k)!.map(e => ({ code: e.code, label: e.label }))])),
      modules,
    };
  }

  private async lists(m: EntityManager): Promise<Map<string, ValueListEntry[]>> {
    const entries = await m.getRepository(ValueListEntry).find({ where: tenantWhere<ValueListEntry>({ isActive: true }), order: { listKey: 'ASC', sortOrder: 'ASC' } });
    const out = new Map<string, ValueListEntry[]>();
    for (const e of entries) out.set(e.listKey, [...(out.get(e.listKey) ?? []), e]);
    return out;
  }

  // ---------------------------------------------------------------- stored data
  private async loadRequest(id: string, m: EntityManager): Promise<CreditRequest> {
    const r = await m.getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!r) throw new NotFoundError('Credit request');
    return r;
  }

  private async stored(id: string, m: EntityManager, model: Model) {
    const rows = await m.getRepository(FormRow).find({ where: tenantWhere<FormRow>({ entityType: ENTITY, entityId: id }), order: { gridCode: 'ASC', orderNo: 'ASC' } });
    const values = await m.getRepository(FieldValue).find({ where: tenantWhere<FieldValue>({ entityType: ENTITY, entityId: id }) });
    const data: FormData = { record: {}, grids: {} };
    const byRow = new Map<string, GridRow>();
    for (const r of rows) {
      const g: GridRow = { rowKey: r.id, values: {} };
      (data.grids[r.gridCode] ??= []).push(g);
      byRow.set(r.id, g);
    }
    for (const v of values) {
      const value = this.readValue(v, model);
      if (v.rowKey === RECORD_ROW) data.record[v.fieldKey] = value;
      else { const g = byRow.get(v.rowKey); if (g) g.values[v.fieldKey] = value; }
    }
    return { data, rows, values };
  }

  private readValue(v: FieldValue, model: Model): Value {
    if (v.valueText !== null) return v.valueText;
    if (v.valueDecimal !== null) return v.valueDecimal;
    if (v.valueBool !== null) return v.valueBool;
    if (v.valueDate) {
      const def = model.fields.get(v.fieldKey);
      return def?.dataType === 'Date' ? v.valueDate.toISOString().slice(0, 10) : v.valueDate.toISOString();
    }
    return null;
  }

  // ---------------------------------------------------------------- GET /credit-requests/:id/data
  async data(id: string, m?: EntityManager) {
    const mgr = m ?? this.ds.manager;
    const r = await this.loadRequest(id, mgr);
    const model = await this.model(mgr);
    const { data } = await this.stored(id, mgr, model);
    return this.view(r, model, data, await this.mode(mgr), mgr);
  }

  private async view(r: CreditRequest, model: Model, data: FormData, mode: MandatoryMode, m: EntityManager) {
    const { def } = await this.workflow.definition(r.requestType, m);
    const record = { ...data.record };
    for (const p of model.placed.values()) if (p.bind) record[p.key] = r[p.bind];
    // hidden fields are not shown to this tenant's users
    for (const k of Object.keys(record)) if (model.fields.get(this.baseKey(k))?.hidden) delete record[k];
    const grids: Record<string, GridRow[]> = {};
    for (const [g, rows] of Object.entries(data.grids)) {
      grids[g] = rows.map(row => ({ rowKey: row.rowKey, values: Object.fromEntries(Object.entries(row.values).filter(([k]) => !model.fields.get(this.baseKey(k))?.hidden)) }));
    }
    return { requestId: r.id, rowVersion: r.rowVersion, editable: !!def.states.find(s => s.code === r.status && s.editable),
      record, grids, completeness: { mode, ...this.completeness(model, data) } };
  }

  private baseKey(k: string) { return k.split(':')[0]; }

  private async mode(m: EntityManager): Promise<MandatoryMode> {
    const v = await this.config.text('credit_request.mandatory_fields_on_submit', m);
    if (!(MANDATORY_MODES as readonly string[]).includes(v)) {
      throw new DomainError('config_invalid', `credit_request.mandatory_fields_on_submit must be one of ${MANDATORY_MODES.join(', ')}`);
    }
    return v as MandatoryMode;
  }

  // ---------------------------------------------------------------- completeness (mandatory manual fields)
  private completeness(model: Model, data: FormData) {
    const modules: Record<string, { mandatory: number; filled: number }> = {};
    const missing: { key: string; label: string; module: string; section: string; rowKey: string | null }[] = [];
    const filled = (key: string, values: Record<string, Value>, meta: FieldMeta) =>
      meta.parts ? meta.parts.every(p => !isEmpty(values[`${key}:${p}`])) : !isEmpty(values[key]);
    for (const p of model.placed.values()) {
      const meta = this.meta(model, p);
      if (!meta || meta.readOnly || meta.requirement !== 'Mandatory' || !meta.source.startsWith('Manual')) continue;
      const tally = (modules[p.module] ??= { mandatory: 0, filled: 0 });
      const check = (values: Record<string, Value>, rowKey: string | null) => {
        tally.mandatory += 1;
        if (filled(p.key, values, meta)) tally.filled += 1;
        else missing.push({ key: p.key, label: meta.label, module: p.module, section: p.section, rowKey });
      };
      if (p.grid === null) check(data.record, null);
      else for (const row of data.grids[p.grid] ?? []) check(row.values, row.rowKey);
    }
    return { modules, missing };
  }

  /** Missing mandatory fields for the submission check, with the tenant's mode. */
  async mandatoryCheck(id: string, m: EntityManager) {
    const mode = await this.mode(m);
    if (mode === 'off') return { mode, missing: [] };
    const model = await this.model(m);
    const { data } = await this.stored(id, m, model);
    return { mode, missing: this.completeness(model, data).missing };
  }

  // ---------------------------------------------------------------- validation of incoming values
  private async validator(m: EntityManager, model: Model) {
    const lists = await this.lists(m);
    const currencies = new Set((await m.getRepository(TenantCurrency).find({ where: tenantWhere<TenantCurrency>({ isActive: true }) })).map(c => c.code));
    return (key: string, raw: unknown, grid: string | null): Value => {
      const [base, part, extra] = key.split(':');
      const placed = model.placed.get(base);
      const def = model.fields.get(base);
      if (!placed || !def || extra !== undefined) throw new DomainError('unknown_field', `"${key}" is not a field of this form`, undefined, { field: key });
      if (placed.grid !== grid) {
        throw new DomainError('unknown_field', `"${key}" belongs to ${placed.grid ? `grid "${placed.grid}"` : 'the record'}`, undefined, { field: key });
      }
      if (def.hidden) throw new DomainError('unknown_field', `"${key}" is not available for this tenant`, undefined, { field: key });
      const meta = this.meta(model, placed)!;
      if (meta.readOnly) throw new DomainError('read_only_field', `"${def.label}" is calculated or read-only`, undefined, { field: key });
      const kind = meta.valueKind === 'composite' ? 'decimal' : meta.valueKind;
      if (meta.valueKind === 'composite' ? !meta.parts!.includes(part) : part !== undefined) {
        throw new DomainError('unknown_field', `"${key}" is not a field of this form`, undefined, { field: key });
      }
      if (isEmpty(raw)) return null;
      const bad = (why: string): never => { throw new DomainError('invalid_value', `${def.label}: ${why}`, undefined, { field: key }); };
      switch (kind) {
        case 'text': {
          if (typeof raw !== 'string') bad('text expected');
          const s = raw as string;
          if (s.length > MAX_TEXT) bad('text is too long');
          if (meta.list && lists.has(meta.list) && !lists.get(meta.list)!.some(e => e.code === s)) bad(`"${s}" is not in the configured list`);
          if (def.dataType === 'Currency Code' && !currencies.has(s)) bad(`currency "${s}" is not enabled for this tenant`);
          return s;
        }
        case 'decimal': {
          if (!isDecimalText(raw)) bad('a decimal number sent as text is expected');
          const d = dec(raw as string);
          if (INTEGER_TYPES.has(def.dataType) && !d.isInteger()) bad('a whole number is expected');
          if (d.decimalPlaces() > STORED_SCALE || d.abs().trunc().toFixed().length > MAX_INTEGER_DIGITS) bad('the number is outside the supported precision');
          return toText(d);
        }
        case 'date': {
          if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
              || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) bad('a date (YYYY-MM-DD) is expected');
          return raw as string;
        }
        case 'bool': if (typeof raw !== 'boolean') bad('true or false is expected'); return raw as boolean;
        default: return bad('this field holds no value');
      }
    };
  }

  // ---------------------------------------------------------------- PUT /credit-requests/:id/data
  async save(id: string, input: SaveInput) {
    return this.ds.transaction(async m => {
      const r = await this.loadRequest(id, m);
      if (r.rowVersion !== input.expectedVersion) {
        throw new ConflictError('This credit request was changed by someone else — reload to see the latest version', { currentVersion: r.rowVersion });
      }
      const { def } = await this.workflow.definition(r.requestType, m);
      if (!def.states.find(s => s.code === r.status && s.editable)) throw new DomainError('not_editable', `A request in state "${r.status}" cannot be edited`);
      const model = await this.model(m);
      const { data: before, rows, values } = await this.stored(id, m, model);
      const check = await this.validator(m, model);

      // apply the changes
      const next: FormData = { record: { ...before.record }, grids: { ...before.grids } };
      for (const [k, v] of Object.entries(input.record ?? {})) next.record[k] = check(k, v, null);
      const existingRows = new Map(rows.map(x => [x.id, x]));
      for (const [grid, list] of Object.entries(input.grids ?? {})) {
        if (!model.doc.grids[grid]) throw new DomainError('unknown_grid', `"${grid}" is not a grid of this form`);
        if (!Array.isArray(list)) throw new DomainError('invalid_value', `Grid "${grid}" must be a list of rows`);
        const seen = new Set<string>();
        const prior = new Map((before.grids[grid] ?? []).map(g => [g.rowKey, g]));
        next.grids[grid] = list.map(row => {
          if (!row || typeof row !== 'object' || typeof row.values !== 'object' || row.values === null) throw new DomainError('invalid_value', `Rows of grid "${grid}" need values`);
          const rowKey = row.rowKey ?? newId();
          if (row.rowKey !== undefined && (existingRows.get(row.rowKey)?.gridCode !== grid || seen.has(row.rowKey))) {
            throw new DomainError('unknown_row', `Row "${row.rowKey}" is not a row of grid "${grid}"`);
          }
          seen.add(rowKey);
          const vals: Record<string, Value> = { ...(prior.get(rowKey)?.values ?? {}) };
          // read-only values are recomputed below; keep only user-entered ones from the previous version
          for (const [k, v] of Object.entries(row.values)) vals[k] = check(k, v, grid);
          return { rowKey, values: vals };
        });
      }

      // recompute calculated fields
      const computed = evaluate(model.compiled, next, await this.formulaContext(m, model));

      // rules (record level, as for the header)
      const ruleRecord = recordView(r, Object.fromEntries(Object.entries(computed.record).filter(([, v]) => !isEmpty(v))));
      const outcome = await this.rules.evaluate(ENTITY, 'on_save', ruleRecord, m);
      enforce(outcome, ruleRecord);

      const changes = await this.persist(m, id, model, before, computed, rows, values);
      const res = await m.getRepository(CreditRequest).update(tenantWhere<CreditRequest>({ id, rowVersion: input.expectedVersion }),
        { rowVersion: input.expectedVersion + 1, updatedAt: new Date() });
      if (res.affected === 0) throw new ConflictError('This credit request was changed by someone else — reload to see the latest version');
      await this.audit.append(m, { action: 'credit_request_data_updated', entityType: ENTITY, entityRef: r.requestNumber, before: changes.before, after: changes.after });
      const fresh = await this.loadRequest(id, m);
      const after = (await this.stored(id, m, model)).data;
      return { ...(await this.view(fresh, model, after, await this.mode(m), m)), warnings: outcome.warnings.map(w => w.message) };
    });
  }

  private async formulaContext(m: EntityManager, model: Model): Promise<FormulaContext> {
    const keys = new Set<string>(['calculation.rounding_mode']);
    model.compiled.forEach(f => f.cfg.forEach(k => keys.add(k)));
    const params = new Map((await m.getRepository(ConfigParameter).find({ where: tenantWhere<ConfigParameter>({ paramKey: In([...keys]) }) })).map(p => [p.paramKey, p]));
    const base = await this.config.baseCurrency(m);
    const rates = await m.getRepository(FxRate).find({ where: tenantWhere<FxRate>({ toCode: base.code }), order: { asOf: 'DESC' } });
    const latest = new Map<string, string>();
    for (const x of rates) if (!latest.has(x.fromCode)) latest.set(x.fromCode, x.rate);
    const rounding = params.get('calculation.rounding_mode');
    if (!rounding) throw new DomainError('config_missing', 'Configuration parameter "calculation.rounding_mode" is not set for this tenant');
    return {
      cfg: key => {
        const p = params.get(key);
        if (!p || (p.valueType !== 'decimal' && p.valueType !== 'integer')) throw new DomainError('config_missing', `Numeric parameter "${key}" used by a formula is not set`);
        return p.paramValue;
      },
      toBase: (amount, ccy) => (ccy === base.code ? amount : latest.has(ccy) ? toText(multiply(amount, latest.get(ccy)!)) : null),
      scale: key => (INTEGER_TYPES.has(model.fields.get(key)?.dataType ?? '') ? 0 : STORED_SCALE),
      roundingMode: rounding.paramValue,
    };
  }

  /** Write the differences between two versions of the data; returns the audit before/after of what changed. */
  private async persist(m: EntityManager, id: string, model: Model, before: FormData, after: FormData, rows: FormRow[], values: FieldValue[]) {
    const tenantId = requireTenant();
    const rowRepo = m.getRepository(FormRow);
    const valRepo = m.getRepository(FieldValue);
    const audit = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };

    // rows: removed, added, reordered
    const keep = new Set<string>();
    const rowInserts: FormRow[] = [];
    const reordered: { id: string; orderNo: number }[] = [];
    for (const [grid, list] of Object.entries(after.grids)) {
      list.forEach((row, index) => {
        keep.add(row.rowKey);
        const cur = rows.find(x => x.id === row.rowKey);
        if (!cur) { rowInserts.push(rowRepo.create({ id: row.rowKey, tenantId, entityType: ENTITY, entityId: id, gridCode: grid, orderNo: index + 1 })); audit.after[`${grid}#${row.rowKey}`] = 'row added'; }
        else if (cur.orderNo !== index + 1) reordered.push({ id: cur.id, orderNo: index + 1 });
      });
    }
    const removed = rows.filter(x => !keep.has(x.id)).map(x => x.id);
    for (let i = 0; i < removed.length; i += CHUNK) {
      const ids = removed.slice(i, i + CHUNK);
      await valRepo.delete(tenantWhere<FieldValue>({ entityType: ENTITY, entityId: id, rowKey: In(ids) }));
      await rowRepo.delete(tenantWhere<FormRow>({ entityType: ENTITY, entityId: id, id: In(ids) }));
    }
    for (const x of rows) if (removed.includes(x.id)) audit.before[`${x.gridCode}#${x.id}`] = 'row removed';
    for (const x of reordered) await rowRepo.update(tenantWhere<FormRow>({ id: x.id }), { orderNo: x.orderNo });
    for (let i = 0; i < rowInserts.length; i += CHUNK) await rowRepo.insert(rowInserts.slice(i, i + CHUNK));

    // values
    const stored = new Map(values.filter(v => v.rowKey === RECORD_ROW || keep.has(v.rowKey)).map(v => [`${v.rowKey}|${v.fieldKey}`, v]));
    const target = new Map<string, Value>();
    for (const [k, v] of Object.entries(after.record)) target.set(`${RECORD_ROW}|${k}`, v);
    for (const list of Object.values(after.grids)) for (const row of list) for (const [k, v] of Object.entries(row.values)) target.set(`${row.rowKey}|${k}`, v);
    const old = (k: string) => { const s = stored.get(k); return s ? this.readValue(s, model) : null; };
    const inserts: FieldValue[] = [];
    const deletes: string[] = [];
    for (const [k, v] of target) {
      const prev = old(k);
      if ((isEmpty(prev) && isEmpty(v)) || prev === v) continue;
      const [rowKey, fieldKey] = k.split('|');
      const label = rowKey === RECORD_ROW ? fieldKey : `${fieldKey}#${rowKey}`;
      audit.before[label] = prev; audit.after[label] = v;
      const cur = stored.get(k);
      if (isEmpty(v)) { if (cur) deletes.push(cur.id); continue; }
      const cols = this.columns(model, fieldKey, v as string | boolean);
      if (cur) await valRepo.update(tenantWhere<FieldValue>({ id: cur.id }), cols);
      else inserts.push(valRepo.create({ id: newId(), tenantId, entityType: ENTITY, entityId: id, fieldKey, rowKey, ...cols }));
    }
    for (let i = 0; i < deletes.length; i += CHUNK) await valRepo.delete(tenantWhere<FieldValue>({ id: In(deletes.slice(i, i + CHUNK)) }));
    for (let i = 0; i < inserts.length; i += CHUNK) await valRepo.insert(inserts.slice(i, i + CHUNK));
    return audit;
  }

  private columns(model: Model, fieldKey: string, v: string | boolean) {
    const def = model.fields.get(this.baseKey(fieldKey));
    const kind = def ? valueKind(def.dataType) : 'text';
    const cols = { valueText: null as string | null, valueDecimal: null as string | null, valueDate: null as Date | null, valueBool: null as boolean | null };
    if (typeof v === 'boolean') cols.valueBool = v;
    else if (kind === 'decimal' || kind === 'composite') { if (isDecimalText(v)) cols.valueDecimal = v; else cols.valueText = v; }
    else if (kind === 'date') cols.valueDate = new Date(`${v}T00:00:00Z`);
    else cols.valueText = v;
    return cols;
  }

  // ---------------------------------------------------------------- formulas (configuration, governed)
  async listFormulas() {
    const model = await this.model(this.ds.manager);
    return [...model.formulas.values()].sort((a, b) => a.fieldKey.localeCompare(b.fieldKey)).map(f => ({
      fieldKey: f.fieldKey, label: model.fields.get(f.fieldKey)?.label ?? f.fieldKey, scope: f.ownerScope === CORE_SCOPE ? 'core' : 'tenant',
      status: f.status, expression: f.expressionJson ? JSON.parse(f.expressionJson) : null, description: f.description, note: f.note, rowVersion: f.rowVersion,
      grid: model.placed.get(f.fieldKey)?.grid ?? null,
    }));
  }

  async validateFormula(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    const model = await this.model(m);
    const def = model.fields.get(fieldKey);
    if (!def || !model.placed.has(fieldKey)) throw new DomainError('invalid_formula', `"${fieldKey}" is not a field of the Credit Request form`);
    if (valueKind(def.dataType) === 'none') throw new DomainError('invalid_formula', `"${def.label}" is display-only`);
    const status = p.status ?? 'active';
    if (status !== 'active' && status !== 'pending') throw new DomainError('invalid_formula', 'status must be active or pending');
    if (typeof p.description !== 'string' || !p.description.trim()) throw new DomainError('invalid_formula', 'A plain-language description is required');
    if (status === 'active' && (p.expression === null || typeof p.expression !== 'object')) throw new DomainError('invalid_formula', 'An active formula needs an expression');
    const defs = this.activeDefs(model.formulas).filter(d => d.field !== fieldKey);
    if (status === 'active') defs.push({ field: fieldKey, expression: p.expression as FormulaDef['expression'] });
    const compiled = compile(defs, k => (model.placed.has(k) ? model.placed.get(k)!.grid : undefined));
    const mine = compiled.find(c => c.field === fieldKey);
    if (mine) {
      const params = new Map((await m.getRepository(ConfigParameter).find({ where: tenantWhere<ConfigParameter>() })).map(x => [x.paramKey, x]));
      for (const k of mine.cfg) {
        const x = params.get(k);
        if (!x || (x.valueType !== 'decimal' && x.valueType !== 'integer')) throw new DomainError('invalid_formula', `Formula reads parameter "${k}", which is not a numeric parameter of this tenant`);
      }
    }
    return model;
  }

  /** Tenant formula (owner scope = tenant) replacing the core formula for this tenant only. */
  async applyFormula(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    await this.validateFormula(m, fieldKey, p);
    const tenantId = requireTenant();
    const repo = m.getRepository(FieldFormula);
    const existing = await repo.findOne({ where: { ownerScope: tenantId, fieldKey } });
    const values = { status: (p.status ?? 'active') as FieldFormula['status'], expressionJson: p.expression ? JSON.stringify(p.expression) : null,
      description: String(p.description), note: (p.note as string) || null, updatedBy: requireActor().userId, updatedAt: new Date() };
    if (existing) {
      if (p.expectedVersion !== undefined && p.expectedVersion !== existing.rowVersion) throw new ConflictError(`Formula "${fieldKey}" was changed by someone else`);
      await repo.update({ id: existing.id, ownerScope: tenantId }, { ...values, rowVersion: existing.rowVersion + 1 });
      return { before: { status: existing.status, expression: existing.expressionJson, description: existing.description }, after: values };
    }
    await repo.insert({ id: newId(), ownerScope: tenantId, fieldKey, ...values, rowVersion: 1 });
    return { before: null, after: values };
  }
}

