/**
 * Connectors to the bank's systems (SDD integration layer): core banking, rating system, data warehouse, credit
 * bureau and the company registry for filed financial statements. Each connector is described by data — a mapping
 * file in seed/connectors — and pulls values into a Credit Request the same way:
 *
 * - The endpoint and credential belong to the deployment (CONNECTOR_<NAME>_URL / _KEY), never to tenant configuration;
 *   a workspace switches a connector on with integration.<name>.enabled and supplies the path variables it needs.
 * - Everything received is untrusted: each value goes through the same list, type, length and format checks as a
 *   user's entry, and values that fail are skipped with a reason instead of being stored. Calculated fields are
 *   never written.
 * - Pulled values are read-only on the request (FormsService.useLocks); every pull is audited and kept as an
 *   integration run, failed ones too.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV } from '../../database/database.module';
import { SEED_DIR } from '../../database/seed';
import type { Env } from '../../config/env';
import { DataLocks, FormsService, LockSource, SystemContext } from '../forms/forms.service';
import type { FormData, GridRow, Value } from '../forms/formula-engine';
import { ConfigurationService } from '../configuration/configuration.service';
import { AuditService } from '../audit/audit.service';
import { CreditRequest } from '../credit-request/credit-request.entities';
import { ENTITY } from '../credit-request/credit-request.service';
import { FieldValue, RECORD_ROW } from '../field-registry/field-registry.entities';
import { IntegrationRun } from './integration.entities';
import { DomainError, NotFoundError } from '../../common/errors';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';

// guardrail-allow: transport limits of the connectors (operational), not business values
const MAX_RESPONSE_CHARS = 2_000_000;
const HTTP_UNAVAILABLE = 502;
const HTTP_NOT_CONFIGURED = 503;
const HTTP_NOT_FOUND = 404;

export interface GridMap {
  from: string; key: string[]; columns: Record<string, string>;
  /** Columns chosen by a value of the response, e.g. the registry's taxonomy (ind-as, us-gaap). */
  columnsBy?: { selector: string; prefix: string; maps: Record<string, Record<string, string>> };
  /** Keep the table ordered by this column (e.g. statement date, oldest first). */
  sortBy?: string;
}
export interface BookingMap {
  endpoint: string; fromGrid: string; actionField: string; actionsParam: string; requires: string[];
  line: Record<string, string>; toGrid: string; key: string; columns: Record<string, string>;
}
export interface ConnectorDef {
  connector: string; label: string; version: number; order: number; note?: string;
  /** Path under the connector URL; {name} is the workspace parameter integration.<connector>.<name>. */
  base: string;
  /** The value that identifies the customer in that system: a request header field or a request field. */
  identifier: { header?: 'borrowerRef'; record?: string; whenField?: string; whenParam?: string; label: string };
  required: string;
  /** What a missing record means: an error (core banking must know the customer) or simply nothing to pull. */
  missing: 'error' | 'skip';
  sources: Record<string, string>;
  header?: { borrowerName?: string };
  record: Record<string, string>;
  grids: Record<string, GridMap>;
  booking?: { limits: BookingMap; collateral: BookingMap };
}
type Doc = Record<string, unknown>;

export function loadConnectorDefs(): ConnectorDef[] {
  const dir = join(SEED_DIR, 'connectors');
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ConnectorDef)
    .sort((a, b) => a.order - b.order);
}

/** All columns a grid mapping may fill, whatever the response selects. */
export function gridColumns(map: GridMap): string[] {
  return [...new Set([...Object.keys(map.columns), ...Object.values(map.columnsBy?.maps ?? {}).flatMap(m => Object.keys(m))])];
}

/** Read a value by path: "customer.group.id", "securityPackages[0].facilities". Missing parts read as undefined. */
export function resolvePath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[m[1]] : undefined;
    for (const idx of m[2].match(/\d+/g) ?? []) cur = Array.isArray(cur) ? cur[Number(idx)] : undefined;
  }
  return cur;
}

/** Values arrive as JSON: numbers are taken as decimal text, so amounts stay exact strings end to end. */
export const raw = (v: unknown): unknown => (v === undefined ? null : typeof v === 'number' ? String(v) : v);
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
export const csv = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

export interface SystemPull {
  system: string; label: string; status: 'pulled' | 'skipped' | 'failed'; message?: string;
  changes: { field: string; label: string; section: string; before: Value | null; after: Value | null }[];
  tables: { grid: string; label: string; added: number; updated: number; removed: number }[];
  warnings: string[];
}
export interface PullResult { pulledAt: string; systems: SystemPull[] }

@Injectable()
export class ConnectorsService implements OnModuleInit {
  private readonly log = new Logger('Connectors');
  readonly defs = loadConnectorDefs();

  constructor(@Inject(ENV) private readonly env: Env, private readonly ds: DataSource, private readonly forms: FormsService,
              private readonly config: ConfigurationService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.forms.useLocks((m, id) => this.locks(m, id));
  }

  def(code: string): ConnectorDef {
    const d = this.defs.find(x => x.connector === code);
    if (!d) throw new DomainError('integration_unknown', `No connector "${code}"`);
    return d;
  }

  // ---------------------------------------------------------------- settings and transport
  param(code: string, name: string) { return `integration.${code}.${name}`; }

  async enabled(code: string, m?: EntityManager): Promise<boolean> {
    try { return await this.config.flag(this.param(code, 'enabled'), m); } catch (e) {
      if (e instanceof DomainError && (e.code === 'config_missing' || e.code === 'config_type')) return false;
      throw e;
    }
  }

  /** Available for this workspace: configured in the deployment and switched on. */
  async available(code: string, m?: EntityManager) { return !!this.env.connectors[code] && await this.enabled(code, m); }

  private async base(def: ConnectorDef, m?: EntityManager) {
    let out = def.base;
    for (const [, name] of def.base.matchAll(/\{([a-z_]+)\}/g)) {
      out = out.replace(`{${name}}`, encodeURIComponent(await this.config.text(this.param(def.connector, name), m)));
    }
    return out;
  }

  async call<T>(code: string, method: 'GET' | 'POST', path: string, body?: unknown, allowNotFound = false): Promise<T | null> {
    const def = this.def(code);
    const conn = this.env.connectors[code];
    if (!conn) throw new DomainError('integration_not_configured', `${def.label} is not connected in this environment`, HTTP_NOT_CONFIGURED);
    if (!(await this.enabled(code))) throw new DomainError('integration_disabled', `${def.label} is switched off for this workspace`);
    const url = `${conn.url}/${await this.base(def)}/${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method, signal: AbortSignal.timeout(conn.timeoutMs), redirect: 'error',
        headers: { 'x-api-key': conn.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      this.log.warn(`${code} ${method} ${path}: ${(e as Error).message}`);
      throw new DomainError('integration_unavailable', `${def.label} did not respond — try again later`, HTTP_UNAVAILABLE);
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new DomainError('integration_error', `${def.label} sent an unexpectedly large response`, HTTP_UNAVAILABLE);
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { throw new DomainError('integration_error', `${def.label} sent a response that is not JSON`, HTTP_UNAVAILABLE); }
    if (res.status === HTTP_NOT_FOUND && allowNotFound) return null;
    if (!res.ok) {
      const msg = json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : `HTTP ${res.status}`;
      throw new DomainError('integration_error', `${def.label} refused the request: ${msg.slice(0, 200)}`, HTTP_UNAVAILABLE);
    }
    return json as T;
  }

  /** Every connector's state for this workspace. */
  async status() {
    return Promise.all(this.defs.map(async d => {
      const conn = this.env.connectors[d.connector];
      const enabled = await this.enabled(d.connector);
      let reachable = false;
      if (conn) {
        const health = `${conn.url}/health`;
        try { reachable = (await fetch(health, { signal: AbortSignal.timeout(conn.timeoutMs) })).ok; } catch { reachable = false; }
      }
      return { code: d.connector, label: d.label, configured: !!conn, enabled, reachable };
    }));
  }

  // ---------------------------------------------------------------- read-only values on the request
  async runs(m: EntityManager, id: string) {
    return m.getRepository(IntegrationRun).find({
      where: tenantWhere<IntegrationRun>({ entityType: ENTITY, entityId: id, status: 'succeeded' }), order: { finishedAt: 'DESC' } });
  }

  async locks(m: EntityManager, id: string): Promise<DataLocks | null> {
    const runs = await this.runs(m, id);
    const sources: LockSource[] = [];
    for (const d of this.defs) {
      const pull = runs.find(r => r.connector === d.connector && r.direction === 'pull');
      const booking = runs.find(r => r.connector === d.connector && r.direction === 'booking');
      if (!pull && !booking && !(await this.enabled(d.connector, m))) continue;
      const columns: Record<string, string[]> = {};
      for (const [g, map] of Object.entries(d.grids)) columns[g] = gridColumns(map);
      for (const b of Object.values(d.booking ?? {})) columns[b.toGrid] = Object.keys(b.columns);
      sources.push({ system: d.connector, label: d.label, pulledAt: pull?.finishedAt.toISOString() ?? null,
        record: pull?.recordFields ? JSON.parse(pull.recordFields) as string[] : [], columns });
    }
    const booking = runs.find(r => r.direction === 'booking');
    if (!sources.length && !booking) return null;
    return { sources, bookedAt: booking?.finishedAt.toISOString() ?? null };
  }

  // ---------------------------------------------------------------- pull
  /** After a request is created: pull from every available system; failures are reported, the request stays. */
  async afterCreate(id: string): Promise<{ pulled: boolean; warnings: string[]; changes?: number; systems?: string[] }> {
    const any = (await Promise.all(this.defs.map(d => this.available(d.connector)))).some(Boolean);
    if (!any) return { pulled: false, warnings: [] };
    const r = await this.pullAll(id, 'create');
    const pulled = r.systems.filter(s => s.status === 'pulled');
    const warnings = r.systems.flatMap(s => (s.status === 'failed' ? [`Not filled from ${s.label.toLowerCase()}: ${s.message}`] : s.warnings));
    return { pulled: pulled.length > 0, warnings, systems: pulled.map(s => s.label),
      changes: pulled.reduce((n, s) => n + s.changes.length + s.tables.reduce((k, t) => k + t.added + t.updated, 0), 0) };
  }

  /** Pull from every available system, in order (core banking first: later systems may need its values). */
  async pullAll(id: string, trigger: 'create' | 'refresh'): Promise<PullResult> {
    const request = await this.ds.manager.getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!request) throw new NotFoundError('Credit request');
    const systems: SystemPull[] = [];
    for (const d of this.defs) {
      if (!(await this.available(d.connector))) continue;
      try { systems.push(await this.pull(d, id, trigger)); } catch (e) {
        systems.push({ system: d.connector, label: d.label, status: 'failed', message: (e as Error).message, changes: [], tables: [], warnings: [] });
        // a request that cannot be edited is refused once, not once per system
        if (e instanceof DomainError && e.code === 'not_editable') throw e;
      }
    }
    return { pulledAt: new Date().toISOString(), systems };
  }

  private async identifier(def: ConnectorDef, id: string, request: CreditRequest): Promise<string | null> {
    if (def.identifier.header) return request[def.identifier.header] || null;
    const keys = [def.identifier.record!, ...(def.identifier.whenField ? [def.identifier.whenField] : [])];
    const vals = await this.ds.manager.getRepository(FieldValue).find({ where: tenantWhere<FieldValue>({ entityType: ENTITY, entityId: id, rowKey: RECORD_ROW }) });
    const get = (k: string) => vals.find(v => v.fieldKey === k)?.valueText ?? null;
    if (def.identifier.whenField && def.identifier.whenParam) {
      const allowed = csv(await this.config.text(def.identifier.whenParam));
      if (!allowed.includes(get(def.identifier.whenField) ?? '')) return null;
    }
    return keys[0] ? get(keys[0]) : null;
  }

  private async fetchDocument(def: ConnectorDef, ident: string): Promise<Doc | null> {
    const path = (p: string) => p.replace('{id}', encodeURIComponent(ident));
    const first = await this.call<Doc>(def.connector, 'GET', path(def.sources[def.required]), undefined, true);
    if (!first) {
      if (def.missing === 'error') throw new DomainError('customer_not_found', `${ident} was not found in ${def.label.toLowerCase()}`);
      return null;
    }
    const doc: Doc = { [def.required]: first };
    const others = Object.entries(def.sources).filter(([k]) => k !== def.required);
    const got = await Promise.all(others.map(([, p]) => this.call<unknown>(def.connector, 'GET', path(p), undefined, true)));
    others.forEach(([k], i) => { doc[k] = got[i] ?? null; });
    return doc;
  }

  async pull(def: ConnectorDef, id: string, trigger: string): Promise<SystemPull> {
    const startedAt = new Date();
    const request = await this.ds.manager.getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!request) throw new NotFoundError('Credit request');
    const base: SystemPull = { system: def.connector, label: def.label, status: 'skipped', changes: [], tables: [], warnings: [] };
    try {
      const ident = await this.identifier(def, id, request);
      if (!ident) return { ...base, message: `No ${def.identifier.label} on the request` };
      const doc = await this.fetchDocument(def, ident);
      if (!doc) return { ...base, message: `${def.label} has no record for ${ident}` };
      return await this.ds.transaction(async m => {
        const out: SystemPull = { ...base, status: 'pulled' };
        const recordFields: string[] = [];
        const titles = new Map<string, { label: string; section: string }>();
        const done = await this.forms.systemUpdate(m, id, { action: 'credit_request_data_pulled', requireEditable: true,
          audit: { connector: def.connector, identifier: ident, trigger } },
          ctx => this.build(def, ctx, doc, out, recordFields, titles));
        for (const k of Object.keys(def.record)) {
          const b = done.before.record[k] ?? null; const a = done.after.record[k] ?? null;
          if (!((isEmpty(a) && isEmpty(b)) || a === b)) {
            const p = titles.get(k) ?? { label: k, section: '' };
            out.changes.push({ field: k, label: p.label, section: p.section, before: b, after: a });
          }
        }
        const finishedAt = new Date();
        await m.getRepository(IntegrationRun).insert({ id: newId(), tenantId: requireTenant(), entityType: ENTITY, entityId: id, connector: def.connector,
          direction: 'pull', status: 'succeeded', triggerName: trigger, recordFields: JSON.stringify(recordFields),
          summaryJson: JSON.stringify({ changes: out.changes.length, tables: out.tables, warnings: out.warnings }), message: null,
          actorId: requireActor().userId, startedAt, finishedAt });
        return out;
      });
    } catch (e) {
      await this.recordFailure(def.connector, id, request.requestNumber, 'pull', trigger, startedAt, e);
      throw e;
    }
  }

  private build(def: ConnectorDef, ctx: SystemContext, doc: Doc, out: SystemPull, recordFields: string[], titles: Map<string, { label: string; section: string }>) {
    const remember = (k: string) => titles.set(k, { label: ctx.label(k), section: ctx.placed(k)?.sectionTitle ?? '' });
    const usable = (k: string) => !!ctx.placed(k) && !ctx.model.fields.get(k)?.hidden && !ctx.calculated(k);
    const record: Record<string, Value> = { ...ctx.before.record };
    for (const [key, path] of Object.entries(def.record)) {
      if (!usable(key)) continue;
      remember(key);
      const v = ctx.value(key, raw(resolvePath(doc, path)), null, record, record);
      if (v.ok) { record[key] = v.value; recordFields.push(key); } else out.warnings.push(v.reason);
    }
    const grids: Record<string, GridRow[]> = { ...ctx.before.grids };
    const rowSources: Map<string, { system: string; ref: string } | null> = new Map();
    const sourceOf = new Map(ctx.rows.filter(r => r.sourceSystem === def.connector).map(r => [r.id, r.sourceRef ?? '']));
    for (const [grid, map] of Object.entries(def.grids)) {
      if (!ctx.model.doc.grids[grid]) continue;
      const rowLabel = ctx.model.doc.grids[grid].rowLabel;
      const chosen = map.columnsBy ? map.columnsBy.maps[String(resolvePath(doc, map.columnsBy.selector) ?? '')] : undefined;
      if (map.columnsBy && !chosen) out.warnings.push(`${def.label}: figures tagged "${String(resolvePath(doc, map.columnsBy.selector))}" have no mapping — only the headers were taken`);
      const all = { ...map.columns, ...Object.fromEntries(Object.entries(chosen ?? {}).map(([k, concept]) => [k, `${map.columnsBy!.prefix}${concept}`])) };
      const columns = Object.entries(all).filter(([k]) => usable(k));
      const mapped = new Set(gridColumns(map));
      const items = resolvePath(doc, map.from);
      const list = Array.isArray(items) ? items.filter((x): x is Doc => !!x && typeof x === 'object') : [];
      const byKey = new Map(list.map(it => [map.key.map(k => String(it[k] ?? '')).join('|'), it]));
      const fill = (values: Record<string, Value>, it: Doc, ref: string) => {
        for (const [col, path] of columns) {
          const v = ctx.value(col, raw(path.startsWith('$.') ? resolvePath(doc, path.slice(2)) : resolvePath(it, path)), grid, values, record);
          if (v.ok) values[col] = v.value; else { values[col] = null; out.warnings.push(`${rowLabel} ${ref}: ${v.reason}`); }
        }
      };
      const tally = { grid, label: rowLabel, added: 0, updated: 0, removed: 0 };
      let rows: GridRow[] = [];
      const used = new Set<string>();
      for (const row of ctx.before.grids[grid] ?? []) {
        const ref = sourceOf.get(row.rowKey);
        if (ref === undefined) { rows.push(row); continue; }
        const it = byKey.get(ref);
        if (it && !used.has(ref)) {
          used.add(ref);
          const values = { ...row.values };
          fill(values, it, ref);
          rows.push({ rowKey: row.rowKey, values });
          if (columns.some(([c]) => (row.values[c] ?? null) !== (values[c] ?? null))) tally.updated += 1;
          continue;
        }
        // no longer in the source system: keep what users added to the row, otherwise drop it
        const userValues = Object.entries(row.values).some(([k, v]) => !mapped.has(k) && !isEmpty(v));
        if (userValues) { rows.push(row); rowSources.set(row.rowKey, null); out.warnings.push(`${rowLabel} ${ref} is no longer in ${def.label.toLowerCase()} — kept as an ordinary row`); }
        tally.removed += 1;
      }
      for (const [ref, it] of byKey) {
        if (used.has(ref)) continue;
        const rowKey = newId();
        const values: Record<string, Value> = {};
        fill(values, it, ref);
        rows.push({ rowKey, values });
        rowSources.set(rowKey, { system: def.connector, ref });
        tally.added += 1;
      }
      if (map.sortBy) {
        const k = map.sortBy;
        rows = rows.map((r, i) => ({ r, i })).sort((a, b) => {
          const x = a.r.values[k]; const y = b.r.values[k];
          if (isEmpty(x) || isEmpty(y)) return isEmpty(x) === isEmpty(y) ? a.i - b.i : isEmpty(x) ? 1 : -1;
          return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : a.i - b.i;
        }).map(x => x.r);
      }
      grids[grid] = rows;
      if (tally.added || tally.updated || tally.removed) out.tables.push(tally);
    }
    let borrowerName: string | undefined;
    if (def.header?.borrowerName) {
      const name = resolvePath(doc, def.header.borrowerName);
      const bound = [...ctx.model.placed.values()].find(p => p.bind === 'borrowerName');
      const max = bound ? ctx.model.attrs.get(bound.key)?.maxLength : undefined;
      if (typeof name === 'string' && name.trim()) {
        if (max !== undefined && max !== null && name.trim().length > max) out.warnings.push(`Borrower name from ${def.label.toLowerCase()} is longer than ${max} characters — not changed`);
        else borrowerName = name.trim();
      }
    }
    return { data: { record, grids } as FormData, rowSources, header: { borrowerName } };
  }

  /** A failed pull or booking is kept and audited too, in its own transaction. */
  async recordFailure(code: string, id: string, requestNumber: string, direction: string, trigger: string, startedAt: Date, e: unknown) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    try {
      await this.ds.transaction(async m => {
        await m.getRepository(IntegrationRun).insert({ id: newId(), tenantId: requireTenant(), entityType: ENTITY, entityId: id, connector: code,
          direction, status: 'failed', triggerName: trigger, recordFields: null, summaryJson: null, message, actorId: requireActor().userId, startedAt, finishedAt: new Date() });
        await this.audit.append(m, { action: `credit_request_${direction === 'pull' ? 'data_pull' : direction}_failed`, entityType: ENTITY, entityRef: requestNumber,
          after: { connector: code, trigger, message } });
      });
    } catch (err) {
      this.log.error(`Could not record the failed ${direction}: ${(err as Error).message}`);
    }
  }
}
