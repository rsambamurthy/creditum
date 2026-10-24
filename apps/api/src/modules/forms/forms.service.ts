/**
 * Credit Request module data (SDD Sections 3–9, 20): the seven module screens, rendered from the layout
 * configuration and stored in the typed value store (ADR 0002). Calculated fields are recomputed on every
 * save by the formula engine; every save is audited in the same transaction.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { FieldFormula, FormLayout, FormRow } from './forms.entities';
import { formatFormula, FUNCTION_HELP, parseFormula } from './formula-text';
import { CompiledFormula, compile, evaluate, FormData, FormulaContext, FormulaDef, GridRow, Value } from './formula-engine';
import { COMPOSITE_PARTS, DISPLAY_ONLY_TYPES, LayoutDocument, LayoutField, mergeLayouts, PlacedField, placements, validateTenantLayout } from './layout';
import { CreditRequest } from '../credit-request/credit-request.entities';
import { CreditRequestService, ENTITY, enforce, recordView } from '../credit-request/credit-request.service';
import { FieldValue, RECORD_ROW } from '../field-registry/field-registry.entities';
import { applyAttributes, FieldAttributes } from '../field-registry/field-attributes';
import { attributeKind, FieldAttributesService } from '../field-registry/field-attributes.service';
import { EffectiveField, FieldRegistryService } from '../field-registry/field-registry.service';
import { ConfigParameter, FxRate, TenantCurrency, ValueListEntry } from '../configuration/configuration.entities';
import { ConfigurationService, GovernanceService } from '../configuration/configuration.service';
import { REQUEST_CONTEXT, RuleContext, ruleReferences, RulesService } from '../rules/rules.service';
import { Rule } from '../rules/rule-evaluator';
import { WorkflowService } from '../workflow/workflow.service';
import { WorkflowDefinition } from '../workflow/workflow.entities';
import { AuditService } from '../audit/audit.service';
import { CORE_SCOPE, T } from '../../common/db-types';
import { dec, isDecimalText, multiply, toText } from '../../common/decimal';
import { ConflictError, DomainError, NotFoundError } from '../../common/errors';
import { FormulaError } from './formula-engine';
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
  /** Effective field attributes (product → market → bank): length, format, range, width. */
  attrs?: FieldAttributes;
}

interface Model {
  doc: LayoutDocument;
  placed: Map<string, PlacedField>;
  fields: Map<string, EffectiveField>;
  formulas: Map<string, FieldFormula>;
  compiled: CompiledFormula[];
  attrs: Map<string, FieldAttributes>;
}

export interface SaveInput { expectedVersion: number; record?: Record<string, unknown>; grids?: Record<string, { rowKey?: string; values: Record<string, unknown> }[]> }

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

@Injectable()
export class FormsService implements OnModuleInit {
  constructor(private readonly ds: DataSource, private readonly registry: FieldRegistryService, private readonly config: ConfigurationService,
              private readonly governance: GovernanceService, private readonly rules: RulesService, private readonly workflow: WorkflowService,
              private readonly audit: AuditService, private readonly requests: CreditRequestService,
              private readonly attributes: FieldAttributesService) {}

  onModuleInit() {
    this.requests.useMandatoryCheck((id, m) => this.mandatoryCheck(id, m));
    this.rules.useReferenceCheck((m, rule, ctx) => this.checkRuleReferences(m, rule, ctx));
    this.requests.useFormCheck((m, header, fields) => this.checkRequestForm(m, header, fields));
    this.governance.register('layout', (m, ref, p) => this.applyLayout(m, ref, p), (m, ref, p) => this.validateLayout(m, ref, p));
    this.governance.register('formula', (m, ref, p) => this.applyFormula(m, ref, p), (m, ref, p) => this.validateFormula(m, ref, p).then(() => undefined));
  }

  // ---------------------------------------------------------------- model: layout + effective fields + formulas
  private async model(m: EntityManager): Promise<Model> {
    const { core, tenant } = await this.layoutRows(m);
    const fields = new Map((await this.registry.effective(m)).map(f => [f.fieldKey, f]));
    const custom = new Set([...fields.values()].filter(f => f.scope === 'tenant').map(f => f.fieldKey));
    const coreDoc = JSON.parse(core.definitionJson) as LayoutDocument;
    const doc = tenant ? mergeLayouts(JSON.parse(tenant.definitionJson) as LayoutDocument, coreDoc, custom) : coreDoc;
    this.placeCustomFields(doc, fields);
    const placed = placements(doc);
    const formulas = await this.effectiveFormulas(m);
    const compiled = compile(this.activeDefs(formulas), k => (placed.has(k) ? placed.get(k)!.grid : undefined));
    return { doc, placed, fields, formulas, compiled, attrs: await this.attributes.effective(m) };
  }

  private async layoutRows(m: EntityManager) {
    const rows = await m.getRepository(FormLayout).find({ where: { ownerScope: In(visibleScopes()), layoutKey: LAYOUT_KEY } });
    const core = rows.find(r => r.ownerScope === CORE_SCOPE);
    if (!core) throw new DomainError('config_missing', 'The Credit Request layout is not installed — run the seed step');
    return { core, tenant: rows.find(r => r.ownerScope !== CORE_SCOPE) ?? null };
  }

  /** Tenant custom fields not yet arranged by the tenant join the section of their module and group (a new section if the group is new). */
  private placeCustomFields(doc: LayoutDocument, fields: Map<string, EffectiveField>) {
    const placed = new Set(doc.modules.flatMap(m => m.sections.flatMap(s => s.fields.map(f => f.key))));
    for (const f of fields.values()) {
      if (f.scope !== 'tenant' || placed.has(f.fieldKey)) continue;
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
    const attrs = model.attrs.get(lf.key);
    if (attrs && Object.keys(attrs).length) out.attrs = attrs;
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
    const places = async (key: string) => this.config.integer(key, m);
    const createForm = (model.doc.createFields ?? []).map(k => model.placed.get(k)).filter((p): p is PlacedField => !!p)
      .map(p => this.meta(model, p)).filter((x): x is FieldMeta => !!x && !x.readOnly);
    createForm.forEach(f => f.list && used.add(f.list));
    return {
      version: model.doc.version,
      // fields on the New Credit Request form besides the header (configurable on the screen-layout page)
      createForm,
      // display rounding of calculated percentages and ratios (stored values keep full precision)
      display: { percentagePlaces: await places('display.percentage_places'), ratioPlaces: await places('display.ratio_places') },
      baseCurrency: currencies.find(c => c.isBase)?.code ?? null,
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

  /**
   * Apply field attributes to the values sent (and to values whose format depends on a field that was sent),
   * normalising case and rejecting values outside length, format or range. Mutates `values`.
   */
  private checkAttributes(model: Model, values: Record<string, Value>, rowKey: string | null, sent: Set<string>, record: Record<string, Value>) {
    const keys = new Set(sent);
    for (const k of Object.keys(values)) {
      const dep = model.attrs.get(this.baseKey(k))?.variants?.dependsOn;
      if (dep && sent.has(dep)) keys.add(k);
    }
    for (const k of keys) {
      const v = values[k];
      const base = this.baseKey(k);
      const a = model.attrs.get(base);
      const def = model.fields.get(base);
      if (v === null || v === undefined || !a || !def) continue;
      const dep = a.variants ? (values[a.variants.dependsOn] ?? record[a.variants.dependsOn]) : undefined;
      try {
        values[k] = applyAttributes(v, a, k.includes(':') ? 'decimal' : attributeKind(def.dataType), dep, def.label) as Value;
      } catch (e) {
        throw new DomainError('invalid_value', (e as Error).message, undefined, { field: k, rowKey });
      }
    }
  }

  /**
   * The New / Edit Credit Request form: only configured fields are accepted; header fields bound to library
   * fields (borrower name, customer number) follow those fields' attributes. Returns normalised values.
   */
  async checkRequestForm(m: EntityManager, header: { borrowerName?: string; borrowerRef?: string }, fields: Record<string, unknown> | undefined) {
    const model = await this.model(m);
    const allowed = new Set(model.doc.createFields ?? []);
    const extra = Object.keys(fields ?? {}).filter(k => !allowed.has(k));
    if (extra.length) throw new DomainError('unknown_field', `Not on the credit request form: ${extra.join(', ')} — enter module fields on the request's tabs`, undefined, { fields: extra });
    const out = { ...header };
    for (const p of model.placed.values()) {
      if (!p.bind) continue;
      const v = header[p.bind];
      const a = model.attrs.get(p.key);
      if (typeof v !== 'string' || !a) continue;
      try { out[p.bind] = applyAttributes(v, a, 'text', undefined, p.bind === 'borrowerName' ? 'Borrower name' : 'Borrower reference') as string; }
      catch (e) { throw new DomainError('invalid_value', (e as Error).message, undefined, { field: p.bind }); }
    }
    const values: Record<string, Value> = Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, v as Value]));
    this.checkAttributes(model, values, null, new Set(Object.keys(values)), values);
    return { header: out, fields: values };
  }

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
    const missing: { key: string; label: string; module: string; section: string; sectionTitle: string; rowKey: string | null }[] = [];
    const filled = (key: string, values: Record<string, Value>, meta: FieldMeta) =>
      meta.parts ? meta.parts.every(p => !isEmpty(values[`${key}:${p}`])) : !isEmpty(values[key]);
    for (const p of model.placed.values()) {
      const meta = this.meta(model, p);
      if (!meta || meta.readOnly || meta.requirement !== 'Mandatory' || !meta.source.startsWith('Manual')) continue;
      const tally = (modules[p.module] ??= { mandatory: 0, filled: 0 });
      const check = (values: Record<string, Value>, rowKey: string | null) => {
        tally.mandatory += 1;
        if (filled(p.key, values, meta)) tally.filled += 1;
        else missing.push({ key: p.key, label: meta.label, module: p.module, section: p.section, sectionTitle: p.sectionTitle, rowKey });
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

      // field attributes (length, format, range) — checked with the other values of the same row / record in view
      const sentRecord = new Set(Object.keys(input.record ?? {}));
      this.checkAttributes(model, next.record, null, sentRecord, next.record);
      for (const [grid, list] of Object.entries(input.grids ?? {})) {
        list.forEach((row, i) => this.checkAttributes(model, next.grids[grid][i].values, next.grids[grid][i].rowKey, new Set(Object.keys(row.values)), next.record));
      }

      // recompute calculated fields
      const computed = evaluate(model.compiled, next, await this.formulaContext(m, model));

      // rules (record level, as for the header)
      const ruleRecord = recordView(r, Object.fromEntries(Object.entries(computed.record).filter(([, v]) => !isEmpty(v))));
      // rules for what is being saved: the modules of the fields sent, and the request form if any of its fields were sent
      const sent = [...Object.keys(input.record ?? {}), ...Object.values(input.grids ?? {}).flatMap(rows => rows.flatMap(r => Object.keys(r.values ?? {}))),
      ].map(k => this.baseKey(k));
      const contexts = new Set(sent.map(k => model.placed.get(k)?.module).filter((x): x is string => !!x));
      for (const g of Object.keys(input.grids ?? {})) {
        const mod = model.doc.modules.find(x => x.sections.some(sec => sec.grid === g));
        if (mod) contexts.add(mod.code);
      }
      if (sent.some(k => (model.doc.createFields ?? []).includes(k))) contexts.add(REQUEST_CONTEXT);
      const outcome = await this.rules.evaluateIn({ trigger: 'on_save', contexts: [...contexts] }, ruleRecord, m);
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

  /** Check a formula without submitting it (formula editor). */
  async checkFormula(fieldKey: string, p: Record<string, unknown>) {
    return this.ds.transaction(async m => {
      await this.validateFormula(m, fieldKey, { description: 'check', ...p });
      return { valid: true };
    });
  }

  // ---------------------------------------------------------------- layout administration (configuration, governed)
  /** The effective layout with every field (hidden ones too), for the layout editor. */
  async layoutAdmin() {
    const m = this.ds.manager;
    const model = await this.model(m);
    const { core, tenant } = await this.layoutRows(m);
    const fields = Object.fromEntries([...model.placed.keys()].map(k => {
      const f = model.fields.get(k);
      return [k, { label: f?.label ?? k, dataType: f?.dataType ?? '', requirement: f?.requirement ?? '', hidden: f?.hidden ?? false,
        scope: f?.scope ?? 'core', calculated: model.formulas.has(k) }];
    }));
    return { scope: tenant ? 'tenant' : 'core', coreVersion: core.layoutVersion, updatedAt: (tenant ?? core).updatedAt, document: model.doc, fields };
  }

  async validateLayout(m: EntityManager, _ref: string, p: Record<string, unknown>) {
    const { core, tenant } = await this.layoutRows(m);
    if (p.reset === true) {
      if (!tenant) throw new DomainError('invalid_layout', 'This tenant already uses the core layout');
      return;
    }
    const fields = await this.registry.effective(m);
    const custom = new Set(fields.filter(f => f.scope === 'tenant').map(f => f.fieldKey));
    const coreDoc = JSON.parse(core.definitionJson) as LayoutDocument;
    try {
      validateTenantLayout(p.document as LayoutDocument, coreDoc, custom);
    } catch (e) {
      throw new DomainError('invalid_layout', (e as Error).message);
    }
  }

  async applyLayout(m: EntityManager, ref: string, p: Record<string, unknown>) {
    await this.validateLayout(m, ref, p);
    const tenantId = requireTenant();
    const { core, tenant } = await this.layoutRows(m);
    const repo = m.getRepository(FormLayout);
    if (p.reset === true) {
      await repo.delete({ id: tenant!.id, ownerScope: tenantId });
      return { before: { scope: 'tenant' }, after: { scope: 'core', version: core.layoutVersion } };
    }
    const d = p.document as LayoutDocument;
    // store only the arrangement; grids and field properties always come from the core layout
    const definitionJson = JSON.stringify({ layout: LAYOUT_KEY, version: core.layoutVersion, grids: {},
      ...(d.createFields ? { createFields: d.createFields } : {}), modules: d.modules.map(mod => ({
      code: mod.code, letter: mod.letter, title: mod.title.trim(), sections: mod.sections.map(s => ({ code: s.code, title: s.title.trim(), kind: s.kind,
        ...(s.grid ? { grid: s.grid, rowLabel: s.rowLabel } : {}), fields: s.fields.map(f => ({ ...f })), ...(s.columns ? { columns: s.columns.map(f => ({ ...f })) } : {}) })) })) });
    const summary = (doc: LayoutDocument) => doc.modules.map(mod => `${mod.title}: ${mod.sections.map(s => s.title).join(', ')}`);
    if (tenant) {
      await repo.update({ id: tenant.id, ownerScope: tenantId }, { layoutVersion: core.layoutVersion, definitionJson, updatedAt: new Date() });
      return { before: summary(JSON.parse(tenant.definitionJson)), after: summary(d) };
    }
    await repo.insert({ id: newId(), ownerScope: tenantId, layoutKey: LAYOUT_KEY, layoutVersion: core.layoutVersion, definitionJson, updatedAt: new Date() });
    return { before: summary(JSON.parse(core.definitionJson)), after: summary(d) };
  }

  // ---------------------------------------------------------------- formulas (configuration, governed)
  /** Resolves and names fields in formula text, preferring fields in the target's own scope when labels repeat. */
  private textNames(model: Model, target: string) {
    const scope = model.placed.get(target)?.grid ?? null;
    const section = model.placed.get(target)?.sectionTitle;
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    const entries = [...model.placed.values()].filter(p => model.fields.has(p.key) && valueKind(model.fields.get(p.key)!.dataType) !== 'none')
      .map(p => ({ key: p.key, label: model.fields.get(p.key)!.label, section: p.sectionTitle, grid: p.grid }));
    const candidates = (ref: string) => {
      const [a, b] = ref.split(/\s*[›>]\s*/);
      const hits = b === undefined ? entries.filter(e => norm(e.label) === norm(a) || e.key === a)
        : entries.filter(e => norm(e.section) === norm(a) && norm(e.label) === norm(b));
      // when a label repeats, prefer the target's own section, then its own table (or record level)
      const sameSection = hits.filter(e => e.section === section);
      if (sameSection.length === 1) return sameSection;
      const own = hits.filter(e => e.grid === scope || e.grid === null);
      return own.length ? own : hits;
    };
    return {
      resolve: (ref: string) => {
        const c = candidates(ref);
        if (!c.length) throw new FormulaError(`No field called [${ref}]`);
        if (c.length > 1) throw new FormulaError(`[${ref}] is ambiguous — write it as ${c.slice(0, 3).map(x => `[${x.section} › ${x.label}]`).join(' or ')}`);
        return c[0].key;
      },
      name: (key: string) => {
        const e = entries.find(x => x.key === key);
        if (!e) return key;
        const c = candidates(e.label);
        return c.length === 1 && c[0].key === key ? e.label : `${e.section} › ${e.label}`;
      },
      grid: (key: string) => model.placed.get(key)?.grid ?? null,
    };
  }

  /** Formula text (spreadsheet style) → stored expression, with the normalised text. */
  parseText(model: Model, fieldKey: string, text: string) {
    if (!model.placed.has(fieldKey)) throw new DomainError('invalid_formula', `"${fieldKey}" is not a field of the Credit Request form`);
    const names = this.textNames(model, fieldKey);
    try {
      const expression = parseFormula(text, names, names.grid);
      return { expression, text: formatFormula(expression, names) };
    } catch (e) {
      throw new DomainError('invalid_formula', (e as Error).message);
    }
  }

  async parseFormulaText(fieldKey: string, text: string) {
    return this.parseText(await this.model(this.ds.manager), fieldKey, text);
  }

  /** Calculate a candidate formula on a saved credit request without changing anything. */
  async previewFormula(fieldKey: string, p: { expression?: unknown; text?: string; requestId: string }) {
    const m = this.ds.manager;
    const model = await this.model(m);
    const expression = p.text !== undefined ? this.parseText(model, fieldKey, p.text).expression : p.expression;
    if (!expression || typeof expression !== 'object') throw new DomainError('invalid_formula', 'An expression or formula text is needed');
    await this.loadRequest(p.requestId, m);
    const defs = this.activeDefs(model.formulas).filter(d => d.field !== fieldKey);
    defs.push({ field: fieldKey, expression: expression as FormulaDef['expression'] });
    let compiled: CompiledFormula[];
    try { compiled = compile(defs, k => (model.placed.has(k) ? model.placed.get(k)!.grid : undefined)); }
    catch (e) { throw new DomainError('invalid_formula', (e as Error).message); }
    const { data } = await this.stored(p.requestId, m, model);
    const out = evaluate(compiled, data, await this.formulaContext(m, { ...model, compiled }));
    const grid = model.placed.get(fieldKey)!.grid;
    if (grid === null) return { value: out.record[fieldKey] ?? null };
    const labelField = model.doc.grids[grid]?.labelField;
    return { rows: (out.grids[grid] ?? []).map((r, i) => ({ rowKey: r.rowKey, label: (labelField && r.values[labelField]) || `${model.doc.grids[grid].rowLabel} ${i + 1}`,
      value: r.values[fieldKey] ?? null })) };
  }

  functionHelp() { return FUNCTION_HELP; }

  // ---------------------------------------------------------------- rules: what a rule can refer to (rule builder)
  private static readonly HEADER_FIELDS = [
    { key: 'borrower_name', label: 'Borrower name', dataType: 'Text' },
    { key: 'borrower_ref', label: 'Borrower reference', dataType: 'Text (identifier)' },
    { key: 'request_type', label: 'Request type', dataType: 'Dropdown', list: 'request_type' },
    { key: 'requested_amount', label: 'Requested amount', dataType: 'Currency Amount' },
    { key: 'currency_code', label: 'Currency', dataType: 'Currency Code' },
    { key: 'base_amount', label: 'Requested amount in base currency', dataType: 'Currency Amount' },
    { key: 'required_level', label: 'Required authority level', dataType: 'Text' },
  ];

  /** Fields (request header and record-level form fields) and numeric/text parameters a rule may use. */
  async rulesCatalog() {
    const m = this.ds.manager;
    const model = await this.model(m);
    const lists = await this.lists(m);
    const params = await m.getRepository(ConfigParameter).find({ where: tenantWhere<ConfigParameter>(), order: { paramKey: 'ASC' } });
    const currencies = await m.getRepository(TenantCurrency).find({ where: tenantWhere<TenantCurrency>({ isActive: true }), order: { code: 'ASC' } });
    const modTitle = new Map(model.doc.modules.map(x => [x.code, x.title]));
    const header = FormsService.HEADER_FIELDS.map(h => ({ ...h, group: 'Request', module: REQUEST_CONTEXT, onCreateForm: true, section: 'Request header',
      valueKind: valueKind(h.dataType), hidden: false }));
    const form = [...model.placed.values()].filter(p => p.grid === null && model.fields.has(p.key)).map(p => {
      const f = model.fields.get(p.key)!;
      return { key: p.key, label: f.label, dataType: f.dataType, valueKind: valueKind(f.dataType), group: modTitle.get(p.module) ?? p.module,
        module: p.module, onCreateForm: (model.doc.createFields ?? []).includes(p.key), section: p.sectionTitle, hidden: f.hidden, ...(p.list ? { list: p.list } : {}) };
    }).filter(f => f.valueKind !== 'none' && f.valueKind !== 'composite');
    const used = new Set([...header, ...form].map(f => (f as { list?: string }).list).filter((x): x is string => !!x));
    return {
      fields: [...header, ...form],
      parameters: params.map(p => ({ key: p.paramKey, valueType: p.valueType, value: p.paramValue, description: p.description })),
      lists: Object.fromEntries([...used].filter(k => lists.has(k)).map(k => [k, lists.get(k)!.map(e => ({ code: e.code, label: e.label }))])),
      currencies: currencies.map(c => ({ code: c.code, name: c.name })),
      // where a rule can run (see checkRuleReferences)
      contexts: {
        modules: model.doc.modules.map(x => ({ code: x.code, title: x.title })),
        createFields: model.doc.createFields ?? [],
        actions: await this.workflowActions(m),
      },
    };
  }

  private async workflowActions(m: EntityManager) {
    const defs = await m.getRepository(WorkflowDefinition).find({ where: tenantWhere<WorkflowDefinition>() });
    const out = new Map<string, string>();
    for (const d of defs) for (const t of (JSON.parse(d.definitionJson).transitions as { action: string; label: string }[])) if (!out.has(t.action)) out.set(t.action, t.label);
    return [...out].map(([code, label]) => ({ code, label }));
  }


  /**
   * A rule may only use fields that exist where it runs. On the New/Edit Credit Request form: the header and the
   * form's configured fields. On a module save: those, plus the module's fields (conditions may read any saved
   * record field). At submission or a workflow action: any record-level field.
   */
  private async checkRuleReferences(m: EntityManager, rule: Pick<Rule, 'condition' | 'actions'>, ctx: RuleContext) {
    const model = await this.model(m);
    const { vars, cfgs, actionFields } = ruleReferences(rule);
    const header = new Set(FormsService.HEADER_FIELDS.map(h => h.key));
    const createFields = new Set(model.doc.createFields ?? []);
    const recordField = (k: string) => model.placed.get(k)?.grid === null;
    const label = (k: string) => model.fields.get(k)?.label ?? FormsService.HEADER_FIELDS.find(h => h.key === k)?.label ?? k;
    const modules = new Map(model.doc.modules.map(x => [x.code, x.title]));
    if (ctx.trigger === 'on_save') {
      for (const c of ctx.contexts) if (c !== REQUEST_CONTEXT && !modules.has(c)) throw new DomainError('invalid_rule', `Unknown screen "${c}" to check on save`);
    }
    if (ctx.trigger === 'on_action') {
      const actions = new Set((await this.workflowActions(m)).map(a => a.code));
      for (const a of ctx.contexts) if (!actions.has(a)) throw new DomainError('invalid_rule', `"${a}" is not a workflow action of this workspace`);
    }
    for (const v of vars) if (!header.has(v) && !recordField(v)) throw new DomainError('invalid_rule', `The rule refers to an unknown field "${v}"`);
    for (const f of actionFields) if (!recordField(f)) throw new DomainError('invalid_rule', `The rule's action refers to an unknown field "${f}"`);
    if (ctx.trigger === 'on_save') {
      const onlyRequest = ctx.contexts.every(c => c === REQUEST_CONTEXT);
      const inScope = (k: string) => createFields.has(k) || (ctx.contexts.includes(model.placed.get(k)?.module ?? ''));
      if (onlyRequest) {
        for (const v of vars) if (!header.has(v) && !createFields.has(v)) {
          throw new DomainError('invalid_rule', `"${label(v)}" is not on the New Credit Request form, so a rule checked there cannot use it — check it when its module is saved, or at submission`);
        }
      }
      for (const f of actionFields) if (!inScope(f)) {
        throw new DomainError('invalid_rule', `"${label(f)}" cannot be ${rule.actions.find(a => a.field === f)?.type === 'hide' ? 'hidden' : 'required'} here: it is not on the screen being saved (${ctx.contexts.map(c => c === REQUEST_CONTEXT ? 'New Credit Request form' : modules.get(c)).join(', ')}) — choose its module, or check at submission`);
      }
    }
    if (cfgs.size) {
      const params = new Set((await m.getRepository(ConfigParameter).find({ where: tenantWhere<ConfigParameter>({ paramKey: In([...cfgs]) }) })).map(p => p.paramKey));
      for (const c of cfgs) if (!params.has(c)) throw new DomainError('invalid_rule', `The rule refers to a parameter "${c}" that is not configured`);
    }
  }

  async listFormulas() {
    const model = await this.model(this.ds.manager);
    const text = (f: FieldFormula) => {
      if (!f.expressionJson) return null;
      try { return formatFormula(JSON.parse(f.expressionJson), this.textNames(model, f.fieldKey)); } catch { return null; }
    };
    return [...model.formulas.values()].sort((a, b) => a.fieldKey.localeCompare(b.fieldKey)).map(f => ({
      text: text(f),
      fieldKey: f.fieldKey, label: model.fields.get(f.fieldKey)?.label ?? f.fieldKey, scope: f.ownerScope === CORE_SCOPE ? 'core' : 'tenant',
      status: f.status, expression: f.expressionJson ? JSON.parse(f.expressionJson) : null, description: f.description, note: f.note, rowVersion: f.rowVersion,
      grid: model.placed.get(f.fieldKey)?.grid ?? null,
    }));
  }

  async validateFormula(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    const model = await this.model(m);
    if (p.revert === true) {
      if (model.formulas.get(fieldKey)?.ownerScope !== requireTenant()) throw new DomainError('invalid_formula', `"${fieldKey}" has no tenant formula to remove`);
      return model;
    }
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
    if (p.revert === true && existing) {
      await repo.delete({ id: existing.id, ownerScope: tenantId });
      return { before: { status: existing.status, expression: existing.expressionJson, description: existing.description }, after: { revertedTo: 'core' } };
    }
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

