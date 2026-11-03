/**
 * Core banking connector (SDD integration layer): pulls the customer, existing facilities, security packages,
 * guarantees and collateral into a Credit Request, and books approved limits and collateral back.
 *
 * - The endpoint and credential belong to the deployment (environment), never to tenant configuration.
 * - Which fields are filled from which part of the core banking response is data: seed/connectors/core-banking.json.
 * - Everything received is untrusted: each value goes through the same list, type, length and format checks as a
 *   user's entry, and values that fail are skipped with a reason instead of being stored.
 * - Pulled values are read-only on the request (FormsService.useLocks); every pull and booking is audited and kept
 *   as an integration run.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV } from '../../database/database.module';
import { SEED_DIR } from '../../database/seed';
import type { Env } from '../../config/env';
import { DataLocks, FormsService, SystemContext } from '../forms/forms.service';
import type { FormData, GridRow, Value } from '../forms/formula-engine';
import { ConfigurationService } from '../configuration/configuration.service';
import { AuditService } from '../audit/audit.service';
import { CreditRequest } from '../credit-request/credit-request.entities';
import { ENTITY } from '../credit-request/credit-request.service';
import { IntegrationRun } from './integration.entities';
import { DomainError, NotFoundError } from '../../common/errors';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';

export const CORE_BANKING = 'core_banking';
const PARAM = {
  enabled: 'integration.core_banking.enabled',
  institution: 'integration.core_banking.institution_code',
  bookingStates: 'integration.core_banking.booking_states',
};
// guardrail-allow: transport limits of the connector (operational), not business values
const MAX_RESPONSE_CHARS = 2_000_000;
const HTTP_UNAVAILABLE = 502;
const HTTP_NOT_CONFIGURED = 503;
const HTTP_NOT_FOUND = 404;

interface GridMap { from: string; key: string[]; columns: Record<string, string> }
interface BookingMap {
  endpoint: string; fromGrid: string; actionField: string; actionsParam: string; requires: string[];
  line: Record<string, string>; toGrid: string; key: string; columns: Record<string, string>;
}
interface Mapping {
  connector: string; label: string; version: number;
  sources: Record<string, string>;
  header: { borrowerName?: string };
  record: Record<string, string>;
  grids: Record<string, GridMap>;
  booking: { limits: BookingMap; collateral: BookingMap };
}
type Doc = Record<string, unknown>;

export function loadMapping(): Mapping {
  return JSON.parse(readFileSync(join(SEED_DIR, 'connectors', 'core-banking.json'), 'utf8')) as Mapping;
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
const raw = (v: unknown): unknown => (v === undefined ? null : typeof v === 'number' ? String(v) : v);
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
const csv = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

export interface PullResult {
  pulledAt: string;
  changes: { field: string; label: string; section: string; before: Value | null; after: Value | null }[];
  tables: { grid: string; label: string; added: number; updated: number; removed: number }[];
  warnings: string[];
}

@Injectable()
export class CoreBankingService implements OnModuleInit {
  private readonly log = new Logger('CoreBanking');
  private readonly mapping = loadMapping();

  constructor(@Inject(ENV) private readonly env: Env, private readonly ds: DataSource, private readonly forms: FormsService,
              private readonly config: ConfigurationService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.forms.useLocks((m, id) => this.locks(m, id));
  }

  // ---------------------------------------------------------------- settings and transport
  private async enabled(m?: EntityManager): Promise<boolean> {
    try { return await this.config.flag(PARAM.enabled, m); } catch (e) {
      if (e instanceof DomainError && e.code === 'config_missing') return false;
      throw e;
    }
  }

  private async requireReady(m?: EntityManager) {
    const conn = this.env.connectors.coreBanking;
    if (!conn) throw new DomainError('integration_not_configured', 'Core banking is not connected in this environment', HTTP_NOT_CONFIGURED);
    if (!(await this.enabled(m))) throw new DomainError('integration_disabled', 'Core banking integration is switched off for this workspace');
    return { conn, institution: await this.config.text(PARAM.institution, m) };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, allowNotFound = false): Promise<T | null> {
    const { conn, institution } = await this.requireReady();
    const url = `${conn.url}/v1/institutions/${encodeURIComponent(institution)}/${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method, signal: AbortSignal.timeout(conn.timeoutMs), redirect: 'error',
        headers: { 'x-api-key': conn.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      this.log.warn(`${method} ${path}: ${(e as Error).message}`);
      throw new DomainError('integration_unavailable', 'Core banking did not respond — try again later', HTTP_UNAVAILABLE);
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new DomainError('integration_error', 'Core banking sent an unexpectedly large response', HTTP_UNAVAILABLE);
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { throw new DomainError('integration_error', 'Core banking sent a response that is not JSON', HTTP_UNAVAILABLE); }
    if (res.status === HTTP_NOT_FOUND && allowNotFound) return null;
    if (!res.ok) {
      const msg = json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : `HTTP ${res.status}`;
      throw new DomainError('integration_error', `Core banking refused the request: ${msg.slice(0, 200)}`, HTTP_UNAVAILABLE);
    }
    return json as T;
  }

  /** The connector's state for this workspace: configured in the environment, switched on, and reachable. */
  async status() {
    const conn = this.env.connectors.coreBanking;
    const enabled = await this.enabled();
    let reachable = false;
    if (conn) {
      try { reachable = (await fetch(`${conn.url}/health`, { signal: AbortSignal.timeout(conn.timeoutMs) })).ok; } catch { reachable = false; }
    }
    const text = async (key: string) => { try { return await this.config.text(key); } catch { return null; } };
    const institution = await text(PARAM.institution);
    const bookingStates = csv((await text(PARAM.bookingStates)) ?? '');
    return { label: this.mapping.label, configured: !!conn, enabled, institution, reachable, bookingStates };
  }

  /** Look a customer up by customer number (New Credit Request form). */
  async lookup(cif: string) {
    const c = await this.call<Doc>('GET', `customers/${encodeURIComponent(cif)}`, undefined, true);
    if (!c) throw new DomainError('customer_not_found', `Customer ${cif} was not found in core banking`, HTTP_NOT_FOUND);
    const pick = (k: string) => (typeof c[k] === 'string' ? c[k] as string : null);
    return { cif, name: pick('name'), segment: pick('segment'), newOrExisting: pick('newOrExisting'), idType: pick('idType'), idNumber: pick('idNumber') };
  }

  private async fetchDocument(cif: string): Promise<Doc> {
    const path = (p: string) => p.replace('{cif}', encodeURIComponent(cif));
    const customer = await this.call<Doc>('GET', path(this.mapping.sources.customer), undefined, true);
    if (!customer) throw new DomainError('customer_not_found', `Customer ${cif} was not found in core banking`);
    const doc: Doc = { customer };
    const others = Object.entries(this.mapping.sources).filter(([k]) => k !== 'customer');
    const lists = await Promise.all(others.map(([, p]) => this.call<unknown>('GET', path(p))));
    others.forEach(([k], i) => { doc[k] = Array.isArray(lists[i]) ? lists[i] : []; });
    return doc;
  }

  // ---------------------------------------------------------------- read-only values on the request
  private async runs(m: EntityManager, id: string) {
    const rows = await m.getRepository(IntegrationRun).find({
      where: tenantWhere<IntegrationRun>({ entityType: ENTITY, entityId: id, connector: CORE_BANKING, status: 'succeeded' }), order: { finishedAt: 'DESC' } });
    return { pull: rows.find(r => r.direction === 'pull') ?? null, booking: rows.find(r => r.direction === 'booking') ?? null };
  }

  async locks(m: EntityManager, id: string): Promise<DataLocks | null> {
    const { pull, booking } = await this.runs(m, id);
    if (!pull && !booking && !(await this.enabled(m))) return null;
    const columns: Record<string, string[]> = {};
    for (const [g, map] of Object.entries(this.mapping.grids)) columns[g] = Object.keys(map.columns);
    for (const b of Object.values(this.mapping.booking)) columns[b.toGrid] = Object.keys(b.columns);
    return { system: CORE_BANKING, label: this.mapping.label, pulledAt: pull?.finishedAt.toISOString() ?? null, bookedAt: booking?.finishedAt.toISOString() ?? null,
      record: pull?.recordFields ? JSON.parse(pull.recordFields) as string[] : [], columns };
  }

  // ---------------------------------------------------------------- pull
  /** After a request is created: pull when the connector is available; a failure leaves the request as created. */
  async afterCreate(id: string): Promise<{ pulled: boolean; warnings: string[]; changes?: number }> {
    if (!this.env.connectors.coreBanking || !(await this.enabled())) return { pulled: false, warnings: [] };
    try {
      const r = await this.pull(id, 'create');
      return { pulled: true, warnings: r.warnings, changes: r.changes.length + r.tables.reduce((n, t) => n + t.added + t.updated, 0) };
    } catch (e) {
      return { pulled: false, warnings: [`Not filled from core banking: ${(e as Error).message}`] };
    }
  }

  async pull(id: string, trigger: 'create' | 'refresh'): Promise<PullResult> {
    const startedAt = new Date();
    const request = await this.ds.manager.getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!request) throw new NotFoundError('Credit request');
    try {
      const doc = await this.fetchDocument(request.borrowerRef);
      return await this.ds.transaction(async m => {
        const warnings: string[] = [];
        const recordFields: string[] = [];
        const tables: PullResult['tables'] = [];
        const titles = new Map<string, { label: string; section: string }>();
        const done = await this.forms.systemUpdate(m, id, { action: 'credit_request_core_banking_pulled', requireEditable: true,
          audit: { connector: CORE_BANKING, customer: request.borrowerRef, trigger } },
          ctx => this.buildPull(ctx, doc, warnings, recordFields, tables, titles));
        const changes: PullResult['changes'] = [];
        for (const k of Object.keys(this.mapping.record)) {
          const b = done.before.record[k] ?? null; const a = done.after.record[k] ?? null;
          if (!((isEmpty(a) && isEmpty(b)) || a === b)) {
            const p = titles.get(k) ?? { label: k, section: '' };
            changes.push({ field: k, label: p.label, section: p.section, before: b, after: a });
          }
        }
        const finishedAt = new Date();
        await m.getRepository(IntegrationRun).insert({ id: newId(), tenantId: requireTenant(), entityType: ENTITY, entityId: id, connector: CORE_BANKING,
          direction: 'pull', status: 'succeeded', triggerName: trigger, recordFields: JSON.stringify(recordFields),
          summaryJson: JSON.stringify({ changes: changes.length, tables, warnings }), message: null, actorId: requireActor().userId, startedAt, finishedAt });
        return { pulledAt: finishedAt.toISOString(), changes, tables, warnings };
      });
    } catch (e) {
      await this.recordFailure(id, request.requestNumber, 'pull', trigger, startedAt, e);
      throw e;
    }
  }

  private buildPull(ctx: SystemContext, doc: Doc, warnings: string[], recordFields: string[], tables: PullResult['tables'],
                    titles: Map<string, { label: string; section: string }>) {
    const remember = (k: string) => titles.set(k, { label: ctx.label(k), section: ctx.placed(k)?.sectionTitle ?? '' });
    const usable = (k: string) => !!ctx.placed(k) && !ctx.model.fields.get(k)?.hidden;
    const record: Record<string, Value> = { ...ctx.before.record };
    for (const [key, path] of Object.entries(this.mapping.record)) {
      if (!usable(key)) continue;
      remember(key);
      const v = ctx.value(key, raw(resolvePath(doc, path)), null, record, record);
      if (v.ok) { record[key] = v.value; recordFields.push(key); } else warnings.push(v.reason);
    }
    const grids: Record<string, GridRow[]> = { ...ctx.before.grids };
    const rowSources: Map<string, { system: string; ref: string } | null> = new Map();
    const sourceOf = new Map(ctx.rows.filter(r => r.sourceSystem === CORE_BANKING).map(r => [r.id, r.sourceRef ?? '']));
    for (const [grid, map] of Object.entries(this.mapping.grids)) {
      if (!ctx.model.doc.grids[grid]) continue;
      const rowLabel = ctx.model.doc.grids[grid].rowLabel;
      const columns = Object.entries(map.columns).filter(([k]) => usable(k));
      const items = resolvePath(doc, map.from);
      const list = Array.isArray(items) ? items.filter((x): x is Doc => !!x && typeof x === 'object') : [];
      const byKey = new Map(list.map(it => [map.key.map(k => String(it[k] ?? '')).join('|'), it]));
      const fill = (values: Record<string, Value>, it: Doc, ref: string) => {
        for (const [col, path] of columns) {
          const v = ctx.value(col, raw(resolvePath(it, path)), grid, values, record);
          if (v.ok) values[col] = v.value; else { values[col] = null; warnings.push(`${rowLabel} ${ref}: ${v.reason}`); }
        }
      };
      const tally = { grid, label: rowLabel, added: 0, updated: 0, removed: 0 };
      const out: GridRow[] = [];
      const used = new Set<string>();
      for (const row of ctx.before.grids[grid] ?? []) {
        const ref = sourceOf.get(row.rowKey);
        if (ref === undefined) { out.push(row); continue; }
        const it = byKey.get(ref);
        if (it && !used.has(ref)) {
          used.add(ref);
          const values = { ...row.values };
          fill(values, it, ref);
          out.push({ rowKey: row.rowKey, values });
          if (columns.some(([c]) => (row.values[c] ?? null) !== (values[c] ?? null))) tally.updated += 1;
          continue;
        }
        // no longer in core banking: keep what users added to the row, otherwise drop it
        const userValues = Object.entries(row.values).some(([k, v]) => !map.columns[k] && !isEmpty(v));
        if (userValues) { out.push(row); rowSources.set(row.rowKey, null); warnings.push(`${rowLabel} ${ref} is no longer in core banking — kept as an ordinary row`); }
        tally.removed += 1;
      }
      for (const [ref, it] of byKey) {
        if (used.has(ref)) continue;
        const rowKey = newId();
        const values: Record<string, Value> = {};
        fill(values, it, ref);
        out.push({ rowKey, values });
        rowSources.set(rowKey, { system: CORE_BANKING, ref });
        tally.added += 1;
      }
      grids[grid] = out;
      if (tally.added || tally.updated || tally.removed) tables.push(tally);
    }
    const name = this.mapping.header.borrowerName ? resolvePath(doc, this.mapping.header.borrowerName) : undefined;
    const bound = [...ctx.model.placed.values()].find(p => p.bind === 'borrowerName');
    const max = bound ? ctx.model.attrs.get(bound.key)?.maxLength : undefined;
    let borrowerName: string | undefined;
    if (typeof name === 'string' && name.trim()) {
      if (max !== undefined && max !== null && name.trim().length > max) warnings.push(`Borrower name from core banking is longer than ${max} characters — not changed`);
      else borrowerName = name.trim();
    }
    return { data: { record, grids } as FormData, rowSources, header: { borrowerName } };
  }

  // ---------------------------------------------------------------- booking
  async book(id: string) {
    const startedAt = new Date();
    const request = await this.ds.manager.getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!request) throw new NotFoundError('Credit request');
    await this.requireReady();
    const states = csv(await this.config.text(PARAM.bookingStates));
    if (!states.includes(request.status)) {
      throw new DomainError('not_bookable', `Limits are booked once the request is ${states.join(' or ')} — this request is "${request.status}"`);
    }
    if ((await this.runs(this.ds.manager, id)).booking) throw new DomainError('already_booked', 'This request has already been booked in core banking', 409);
    try {
      const data = await this.forms.data(id);
      const refs = data.integration?.rows ?? {};
      const pick = (map: BookingMap, actions: string[]) => (data.grids[map.fromGrid] ?? [])
        .filter(r => actions.includes(String(r.values[map.actionField] ?? '')) && map.requires.every(k => !isEmpty(r.values[k])))
        .map(r => {
          const line: Record<string, unknown> = {};
          for (const [name, spec] of Object.entries(map.line)) {
            const [kind, key] = spec.split(/:(.*)/s);
            line[name] = kind === 'row' ? r.values[key] ?? null : kind === 'record' ? data.record[key] ?? null
              : kind === 'rowRef' ? (refs[r.rowKey]?.system === CORE_BANKING ? refs[r.rowKey]?.ref ?? null : null) : null;
          }
          return { ref: r.rowKey, line };
        });
      const { limits, collateral } = this.mapping.booking;
      const limitLines = pick(limits, csv(await this.config.text(limits.actionsParam)));
      const collateralItems = pick(collateral, csv(await this.config.text(collateral.actionsParam)));
      if (!limitLines.length && !collateralItems.length) {
        throw new DomainError('nothing_to_book', 'Nothing to book: no facility line has a booking action and a proposed limit, and no new collateral has a booking action');
      }
      type Booked = Record<string, unknown> & { lineRef?: string; itemRef?: string };
      const bookedLimits = limitLines.length ? (await this.call<{ lines: Booked[] }>('POST', limits.endpoint, {
        cif: request.borrowerRef, creditRequestNumber: request.requestNumber, lines: limitLines.map(l => ({ lineRef: l.ref, ...l.line })) }))?.lines ?? [] : [];
      const limitRefs = bookedLimits.map(b => String(b[limits.key] ?? '')).filter(Boolean);
      const bookedCollateral = collateralItems.length ? (await this.call<{ items: Booked[] }>('POST', collateral.endpoint, {
        cif: request.borrowerRef, creditRequestNumber: request.requestNumber,
        items: collateralItems.map(c => ({ itemRef: c.ref, ...c.line, linkedLimits: limitRefs })) }))?.items ?? [] : [];

      return await this.ds.transaction(async m => {
        const warnings: string[] = [];
        const done: { limits: string[]; collateral: string[] } = { limits: [], collateral: [] };
        await this.forms.systemUpdate(m, id, { action: 'credit_request_booked_in_core_banking', requireEditable: false,
          audit: { connector: CORE_BANKING, customer: request.borrowerRef, limits: limitRefs, collateral: bookedCollateral.map(b => b[collateral.key]) } },
          ctx => {
            const grids: Record<string, GridRow[]> = { ...ctx.before.grids };
            const rowSources: Map<string, { system: string; ref: string } | null> = new Map();
            const write = (map: BookingMap, sent: { ref: string; line: Record<string, unknown> }[], booked: Booked[], refKey: 'lineRef' | 'itemRef', into: string[]) => {
              if (!ctx.model.doc.grids[map.toGrid]) return;
              const rows = [...(grids[map.toGrid] ?? [])];
              for (const b of booked) {
                const s = sent.find(x => x.ref === b[refKey]);
                if (!s) continue;
                const values: Record<string, Value> = {};
                for (const [col, spec] of Object.entries(map.columns)) {
                  if (!ctx.placed(col) || ctx.model.fields.get(col)?.hidden) continue;
                  const [kind, key] = spec.split(/:(.*)/s);
                  const v0 = kind === 'booked' ? b[key] : kind === 'line' ? s.line[key] : kind === 'limits' ? limitRefs.join(', ') : null;
                  const v = ctx.value(col, raw(v0), map.toGrid, values, ctx.before.record);
                  if (v.ok) values[col] = v.value; else warnings.push(v.reason);
                }
                const ref = String(b[map.key] ?? '');
                const rowKey = newId();
                rows.push({ rowKey, values });
                rowSources.set(rowKey, { system: CORE_BANKING, ref });
                into.push(ref);
              }
              grids[map.toGrid] = rows;
            };
            write(limits, limitLines, bookedLimits, 'lineRef', done.limits);
            write(collateral, collateralItems, bookedCollateral, 'itemRef', done.collateral);
            return { data: { record: ctx.before.record, grids }, rowSources };
          });
        const finishedAt = new Date();
        await m.getRepository(IntegrationRun).insert({ id: newId(), tenantId: requireTenant(), entityType: ENTITY, entityId: id, connector: CORE_BANKING,
          direction: 'booking', status: 'succeeded', triggerName: 'booking', recordFields: null, summaryJson: JSON.stringify({ ...done, warnings }),
          message: null, actorId: requireActor().userId, startedAt, finishedAt });
        return { bookedAt: finishedAt.toISOString(), limits: done.limits, collateral: done.collateral, warnings };
      });
    } catch (e) {
      await this.recordFailure(id, request.requestNumber, 'booking', 'booking', startedAt, e);
      throw e;
    }
  }

  /** A failed pull or booking is kept and audited too, in its own transaction. */
  private async recordFailure(id: string, requestNumber: string, direction: string, trigger: string, startedAt: Date, e: unknown) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    try {
      await this.ds.transaction(async m => {
        await m.getRepository(IntegrationRun).insert({ id: newId(), tenantId: requireTenant(), entityType: ENTITY, entityId: id, connector: CORE_BANKING,
          direction, status: 'failed', triggerName: trigger, recordFields: null, summaryJson: null, message, actorId: requireActor().userId, startedAt, finishedAt: new Date() });
        await this.audit.append(m, { action: `credit_request_core_banking_${direction}_failed`, entityType: ENTITY, entityRef: requestNumber, after: { trigger, message } });
      });
    } catch (err) {
      this.log.error(`Could not record the failed ${direction}: ${(err as Error).message}`);
    }
  }
}
