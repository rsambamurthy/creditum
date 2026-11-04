/**
 * Core banking specifics (SDD integration layer) on top of the generic connector (connectors.service.ts): the
 * customer list of values and look-up for the New Credit Request form, and booking approved limits and collateral.
 * Pulling customer, facility and collateral data is the generic pull, driven by seed/connectors/core-banking.json.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FormsService } from '../forms/forms.service';
import type { GridRow, Value } from '../forms/formula-engine';
import { ConfigurationService } from '../configuration/configuration.service';
import { CreditRequest } from '../credit-request/credit-request.entities';
import { ENTITY } from '../credit-request/credit-request.service';
import { IntegrationRun } from './integration.entities';
import { BookingMap, ConnectorsService, csv, raw } from './connectors.service';
import { DomainError, NotFoundError } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';

export const CORE_BANKING = 'core_banking';
const PARAM = {
  institution: 'integration.core_banking.institution_code',
  bookingStates: 'integration.core_banking.booking_states',
};
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;
// guardrail-allow: list-of-values paging and input bounds (operational), not business values
const SEARCH = { page: 20, minChars: 2, maxChars: 100 };
type Doc = Record<string, unknown>;
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

/** Core banking specifics on top of the generic connector: customer look-up, list of values and booking. */
@Injectable()
export class CoreBankingService {
  constructor(private readonly ds: DataSource, private readonly forms: FormsService, private readonly config: ConfigurationService,
              private readonly connectors: ConnectorsService, private readonly audit: AuditService) {}

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown, allowNotFound = false) {
    return this.connectors.call<T>(CORE_BANKING, method, path, body, allowNotFound);
  }
  private get mapping() { return this.connectors.def(CORE_BANKING); }

  /** Core banking for the New Credit Request form and the booking button: configured, switched on, reachable. */
  async status() {
    const all = await this.connectors.status();
    const me = all.find(x => x.code === CORE_BANKING)!;
    const text = async (key: string) => { try { return await this.config.text(key); } catch { return null; } };
    return { label: me.label, configured: me.configured, enabled: me.enabled, reachable: me.reachable, institution: await text(PARAM.institution),
      bookingStates: csv((await text(PARAM.bookingStates)) ?? ''), systems: all };
  }

  /**
   * List of values for the customer number: customers whose number or name contains the text, as core banking
   * returns them (name and number, segment). Untrusted input: only strings are passed on.
   */
  async search(q: string) {
    const text = (q ?? '').trim();
    if (text.length < SEARCH.minChars) throw new DomainError('invalid_value', `Type at least ${SEARCH.minChars} characters of the name or customer number`);
    const res = await this.call<{ total?: unknown; items?: unknown }>('GET', `customers?q=${encodeURIComponent(text.slice(0, SEARCH.maxChars))}&limit=${SEARCH.page}`);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const items = (Array.isArray(res?.items) ? res!.items : []).filter((x): x is Doc => !!x && typeof x === 'object' && typeof (x as Doc).cif === 'string')
      .slice(0, SEARCH.page)
      .map(c => ({ cif: c.cif as string, name: str(c.name), segment: str(c.segment), newOrExisting: str(c.newOrExisting), idType: str(c.idType), idNumber: str(c.idNumber) }));
    return { items, total: typeof res?.total === 'number' ? res.total : items.length };
  }

  /** Look a customer up by customer number (New Credit Request form). */
  async lookup(cif: string) {
    const c = await this.call<Doc>('GET', `customers/${encodeURIComponent(cif)}`, undefined, true);
    if (!c) throw new DomainError('customer_not_found', `Customer ${cif} was not found in core banking`, HTTP_NOT_FOUND);
    const pick = (k: string) => (typeof c[k] === 'string' ? c[k] as string : null);
    return { cif, name: pick('name'), segment: pick('segment'), newOrExisting: pick('newOrExisting'), idType: pick('idType'), idNumber: pick('idNumber') };
  }

  // ---------------------------------------------------------------- booking
  /** Create a new customer in core banking from the request (mapping: customerCreation); returns its customer number. */
  private async createCustomer(request: CreditRequest, record: Record<string, Value>): Promise<string> {
    const spec = this.mapping.customerCreation;
    if (!spec) throw new DomainError('customer_number_missing', 'This request has no customer number and core banking cannot create customers here — enter the customer number first');
    const body: Record<string, unknown> = {};
    for (const [name, src] of Object.entries(spec.body)) {
      const [kind, key] = src.split(/:(.*)/s);
      body[name] = kind === 'header' ? (request as unknown as Record<string, unknown>)[key] ?? null : kind === 'record' ? record[key] ?? null : null;
    }
    const res = await this.call<Doc>('POST', spec.endpoint, body);
    const cif = res?.[spec.key];
    if (typeof cif !== 'string' || !cif) throw new DomainError('integration_failed', 'Core banking did not return a customer number for the new customer', HTTP_BAD_GATEWAY);
    return cif;
  }

  async book(id: string) {
    const startedAt = new Date();
    const request = await this.ds.manager.getRepository(CreditRequest).findOne({ where: tenantWhere<CreditRequest>({ id }) });
    if (!request) throw new NotFoundError('Credit request');
    if (!(await this.connectors.available(CORE_BANKING))) throw new DomainError('integration_disabled', 'Core banking is not available for this workspace');
    const states = csv(await this.config.text(PARAM.bookingStates));
    if (!states.includes(request.status)) {
      throw new DomainError('not_bookable', `Limits are booked once the request is ${states.join(' or ')} — this request is "${request.status}"`);
    }
    if ((await this.connectors.runs(this.ds.manager, id)).some(r => r.connector === CORE_BANKING && r.direction === 'booking')) throw new DomainError('already_booked', 'This request has already been booked in core banking', 409);
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
      const { limits, collateral } = this.mapping.booking!;
      const limitLines = pick(limits, csv(await this.config.text(limits.actionsParam)));
      const collateralItems = pick(collateral, csv(await this.config.text(collateral.actionsParam)));
      if (!limitLines.length && !collateralItems.length) {
        throw new DomainError('nothing_to_book', 'Nothing to book: no facility line has a booking action and a proposed limit, and no new collateral has a booking action');
      }
      type Booked = Record<string, unknown> & { lineRef?: string; itemRef?: string };
      // a new customer is created in core banking first; its customer number is used for the booking and kept on the request
      const created = request.borrowerRef ? null : await this.createCustomer(request, data.record);
      const cif = request.borrowerRef ?? created!;
      const bookedLimits = limitLines.length ? (await this.call<{ lines: Booked[] }>('POST', limits.endpoint, {
        cif, creditRequestNumber: request.requestNumber, lines: limitLines.map(l => ({ lineRef: l.ref, ...l.line })) }))?.lines ?? [] : [];
      const limitRefs = bookedLimits.map(b => String(b[limits.key] ?? '')).filter(Boolean);
      const bookedCollateral = collateralItems.length ? (await this.call<{ items: Booked[] }>('POST', collateral.endpoint, {
        cif, creditRequestNumber: request.requestNumber,
        items: collateralItems.map(c => ({ itemRef: c.ref, ...c.line, linkedLimits: limitRefs })) }))?.items ?? [] : [];

      return await this.ds.transaction(async m => {
        const warnings: string[] = [];
        const done: { limits: string[]; collateral: string[] } = { limits: [], collateral: [] };
        await this.forms.systemUpdate(m, id, { action: 'credit_request_booked_in_core_banking', requireEditable: false,
          audit: { connector: CORE_BANKING, customer: cif, customerCreated: !!created, limits: limitRefs, collateral: bookedCollateral.map(b => b[collateral.key]) } },
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
        if (created) {
          await m.getRepository(CreditRequest).update(tenantWhere<CreditRequest>({ id }), { borrowerRef: created });
          await this.audit.append(m, { action: 'customer_created_in_core_banking', entityType: ENTITY, entityRef: request.requestNumber,
            before: { borrower_ref: null }, after: { borrower_ref: created } });
        }
        const finishedAt = new Date();
        await m.getRepository(IntegrationRun).insert({ id: newId(), tenantId: requireTenant(), entityType: ENTITY, entityId: id, connector: CORE_BANKING,
          direction: 'booking', status: 'succeeded', triggerName: 'booking', recordFields: null, summaryJson: JSON.stringify({ ...done, customer: created, warnings }),
          message: null, actorId: requireActor().userId, startedAt, finishedAt });
        return { bookedAt: finishedAt.toISOString(), customer: cif, customerCreated: !!created, limits: done.limits, collateral: done.collateral, warnings };
      });
    } catch (e) {
      await this.connectors.recordFailure(CORE_BANKING, id, request.requestNumber, 'booking', 'booking', startedAt, e);
      throw e;
    }
  }
}
