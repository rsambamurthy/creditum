/**
 * Core banking connector, end to end against the simulator (apps/corebank-sim) started in this process:
 * a new request is filled from core banking, pulled values are read-only, a refresh updates them, and an
 * approved request is booked back. CI runs this on PostgreSQL, Microsoft SQL Server and Oracle.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { createDataSource } from '../../src/database/data-source';
import { loadDbEnv } from '../../src/config/env';
import { seedAll } from '../../src/database/seed';
import { DataSource } from 'typeorm';
import { FxRate } from '../../src/modules/configuration/configuration.entities';
import { Tenant } from '../../src/modules/tenancy/tenancy.entities';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createSimulator } = require('../../../corebank-sim/src/server.js') as { createSimulator: (o: { apiKey: string }) => Server };

let app: INestApplication;
let sim: Server;
const http = () => request(app.getHttpServer());
const tokens = new Map<string, string>();
async function as(tenantCode: string, loginName: string) {
  const k = `${tenantCode}/${loginName}`;
  if (!tokens.has(k)) tokens.set(k, (await http().post('/api/auth/dev-login').send({ tenantCode, loginName }).expect(200)).body.token);
  return { Authorization: `Bearer ${tokens.get(k)}` };
}
const CF = 'b.credit_facilities';
const GI = 'a.general_information.';
const SYSTEMS: [string, string][] = [['CORE_BANKING', ''], ['RATING', '/rating'], ['DATA_WAREHOUSE', '/warehouse'], ['CREDIT_BUREAU', '/bureau'], ['SPREADING', '/spreading'], ['FINANCIAL_STATEMENTS', '/registry']];
const SAVED_ENV = [...SYSTEMS.flatMap(([n]) => [`CONNECTOR_${n}_URL`, `CONNECTOR_${n}_KEY`]), 'CONNECTOR_TIMEOUT_MS'].map(k => [k, process.env[k]] as const);

beforeAll(async () => {
  const apiKey = randomBytes(24).toString('hex');
  sim = createSimulator({ apiKey });
  await new Promise<void>(resolve => sim.listen(0, '127.0.0.1', resolve));
  for (const [name, path] of SYSTEMS) {
    process.env[`CONNECTOR_${name}_URL`] = `http://127.0.0.1:${(sim.address() as AddressInfo).port}${path}`;
    process.env[`CONNECTOR_${name}_KEY`] = apiKey;
  }
  process.env.CONNECTOR_TIMEOUT_MS = '5000';
  const setup = createDataSource(loadDbEnv());
  await setup.initialize();
  await setup.dropDatabase();
  await setup.runMigrations();
  await seedAll(setup);
  await setup.destroy();
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
});
afterAll(async () => {
  await app?.close();
  await new Promise(resolve => sim?.close(resolve));
  for (const [k, v] of SAVED_ENV) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function create(tenant: string, ro: string, cif: string, currencyCode: string, requestedAmount = '100000') {
  return (await http().post('/api/credit-requests').set(await as(tenant, ro)).send({ borrowerName: 'Typed name', borrowerRef: cif,
    requestType: 'new', requestedAmount, currencyCode }).expect(201)).body;
}

describe('base currency (before any credit request exists)', () => {
  const base = async (t: string, u: string) => (await http().get('/api/config/currencies').set(await as(t, u)).expect(200)).body.find((c: { isBase: boolean }) => c.isBase).code;

  it('is changed by a configuration administrator, needs rates to the new base, and is audited', async () => {
    const admin = await as('abc-finance', 'admin.anita');
    await http().put('/api/config/base-currency').set(await as('abc-finance', 'ro.priya')).send({ code: 'USD' }).expect(403);
    expect((await http().put('/api/config/base-currency').set(admin).send({ code: 'INR' }).expect(422)).body.message).toMatch(/already the base currency/);
    expect((await http().put('/api/config/base-currency').set(admin).send({ code: 'USD' }).expect(422)).body).toMatchObject({ error: 'fx_rate_missing' });
    const ds = app.get(DataSource);
    const abc = await ds.getRepository(Tenant).findOneByOrFail({ code: 'abc-finance' });
    await ds.getRepository(FxRate).insert({ id: randomUUID(), tenantId: abc.id,
      fromCode: 'INR', toCode: 'USD', rate: '0.0119', asOf: new Date() });
    expect((await http().put('/api/config/base-currency').set(admin).send({ code: 'USD' }).expect(200)).body).toEqual({ status: 'applied' });
    expect(await base('abc-finance', 'ro.priya')).toBe('USD');
    await http().put('/api/config/base-currency').set(admin).send({ code: 'INR' }).expect(200);
    expect(await base('abc-finance', 'ro.priya')).toBe('INR');
  });

  it('waits for a second administrator where maker-checker is on', async () => {
    const r = (await http().put('/api/config/base-currency').set(await as('xyz-bank', 'admin.fatima')).send({ code: 'USD' }).expect(422)).body;
    expect(r.error).toBe('fx_rate_missing'); // EUR has no rate to USD
  });
});

describe('core banking connector', () => {
  let id = '';
  let version = 0;

  it('reports the connection and looks a customer up by customer number', async () => {
    const st = (await http().get('/api/integrations/core-banking/status').set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body;
    expect(st).toMatchObject({ configured: true, enabled: true, reachable: true, institution: 'xyz-bank' });
    const c = (await http().get('/api/integrations/core-banking/customers/CIF00418823').set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body;
    expect(c).toMatchObject({ name: 'Zelvaro Marine Logistics W.L.L.', segment: 'mid_corporate' });
    await http().get('/api/integrations/core-banking/customers/CIF-UNKNOWN').set(await as('xyz-bank', 'ro.ahmed')).expect(404);
    // list of values: by part of the name or the number, this institution's customers only
    const byName = (await http().get('/api/integrations/core-banking/customers').query({ q: 'zelv' }).set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body;
    expect(byName.items).toEqual([expect.objectContaining({ cif: 'CIF00418823', name: 'Zelvaro Marine Logistics W.L.L.' })]);
    const byNumber = (await http().get('/api/integrations/core-banking/customers').query({ q: 'CIF004' }).set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body;
    expect(byNumber.items.map((c: { cif: string }) => c.cif)).toEqual(expect.arrayContaining(['CIF00418823', 'CIF00456230', 'CIF00477781']));
    expect((await http().get('/api/integrations/core-banking/customers').query({ q: 'tarvenna' }).set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body.items).toEqual([]);
    await http().get('/api/integrations/core-banking/customers').query({ q: 'z' }).set(await as('xyz-bank', 'ro.ahmed')).expect(422);
  });

  it('fills a new request from core banking: customer, group, facilities, package, guarantees, collateral', async () => {
    const res = await create('xyz-bank', 'ro.ahmed', 'CIF00418823', 'KWD');
    expect(res.integration).toMatchObject({ pulled: true });
    expect(res.request.borrowerName).toBe('Zelvaro Marine Logistics W.L.L.');
    id = res.request.id;
    const d = (await http().get(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body;
    expect(d.record).toMatchObject({ [`${GI}customer_name`]: 'Zelvaro Marine Logistics W.L.L.', [`${GI}customer_segment`]: 'mid_corporate',
      [`${GI}customer_id_number`]: '4521873', [`${GI}customer_is_a_board_member_of_the_bank`]: false, 'b.credit_facilities.group_id': 'GRP0091',
      'b.security_package.package_number_existing_package': 'PKG-0418823-A' });
    expect(d.grids[CF]).toHaveLength(3);
    const od = d.grids[CF].find((r: { values: Record<string, unknown> }) => r.values[`${CF}.facility_identifier_product_code_reference_number`] === 'XYZ-OD-0418823-01');
    expect(od.values).toMatchObject({ [`${CF}.current_limit`]: '500000', [`${CF}.current_utilization`]: '312450.25', [`${CF}.limit_currency`]: 'KWD' });
    expect(d.grids['a.partners']).toHaveLength(2);
    expect(d.grids['b.sp_existing_collateral']).toHaveLength(2);
    expect(d.grids['b.guarantees']).toHaveLength(1);
    expect(d.grids['b.collateral_not_in_a_package']).toHaveLength(1);
    // provenance: what came from core banking is listed, and calculated fields use the pulled values
    expect(d.integration.label).toBe('Core banking');
    expect(d.integration.pulledAt).toBeTruthy();
    expect(d.integration.sources[0].record).toEqual(expect.arrayContaining([`${GI}customer_name`, `${GI}customer_segment`]));
    expect(d.integration.rows[od.rowKey]).toEqual({ system: 'core_banking', ref: 'XYZ-OD-0418823-01' });
    expect(d.record['b.security_package.total_existing_facility_value_base_reporting_currency_existing_package']).toBe('1700000');
    // the other bank systems: rating system, data warehouse, credit bureau; own-bank totals from core banking
    expect(d.record).toMatchObject({ 'a.risk_ratings_borrower.internal_rating_current': '4', 'a.risk_ratings_borrower.internal_rating_previous': '5',
      'a.risk_ratings_personal_guarantor.internal_rating_current': '3', 'a.capital_return_summary.existing_raroc': '18.6',
      'a.deal_economics_relationship_profitability.interest_income': '128400', 'a.deal_economics_relationship_profitability.total_relationship_income': '173700',
      'a.relationship_overview.total_deposit': '640000', 'a.relationship_overview.total_cash_limit_other_banks': '900000' });
    expect(d.grids['b.roc_raroc_by_company']).toHaveLength(2);
    expect(d.grids['c.dealings_with_other_banks']).toHaveLength(2);
    // no company registry in Kuwait: the statements come from the bank's spreading system (CreditLens-style), by customer number
    const periods = d.grids['e.financial_periods'] as { rowKey: string; values: Record<string, unknown> }[];
    expect(periods.map(p => p.values['e.financial_statement_header.fiscal_year_financial_statement_date'])).toEqual(['2023-12-31', '2024-12-31', '2025-12-31']);
    expect(periods[2].values).toMatchObject({ 'e.financial_statement_header.statement_type': 'annual_audited', 'e.financial_statement_header.months_covered': '12',
      'e.income_statement.net_sales_revenues': '21250000', 'e.balance_sheet_assets.total_assets': '18006890',
      'e.contingent_liabilities_commitments.letters_of_guarantee_lg': '129360' });
    expect(d.integration.rows[periods[0].rowKey]).toMatchObject({ system: 'spreading', ref: '2023-12-31' });
    expect(d.integration.sources.map((x: { label: string }) => x.label)).toEqual(['Core banking', 'Rating system', 'Data warehouse', 'Credit bureau', 'Spreading system']);
    version = d.rowVersion;
    const audit = (await http().get('/api/audit').set(await as('xyz-bank', 'auditor.hana')).expect(200)).body;
    expect(JSON.stringify(audit)).toContain('credit_request_data_pulled');
  });

  it('keeps pulled values read-only and lets users work on their own columns and rows', async () => {
    const h = await as('xyz-bank', 'ro.ahmed');
    const d = (await http().get(`/api/credit-requests/${id}/data`).set(h).expect(200)).body;
    const bad = await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version, record: { [`${GI}customer_name`]: 'Changed' } }).expect(422);
    expect(bad.body).toMatchObject({ error: 'read_only_field', details: { field: `${GI}customer_name` } });
    expect(bad.body.message).toMatch(/comes from core banking/);
    const rows = d.grids[CF] as { rowKey: string; values: Record<string, unknown> }[];
    const od = rows.find(r => r.values[`${CF}.facility_identifier_product_code_reference_number`] === 'XYZ-OD-0418823-01')!;
    // a pulled column cannot be edited, a pulled row cannot be removed
    await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version, grids: { [CF]: rows.map(r => r.rowKey === od.rowKey
      ? { rowKey: r.rowKey, values: { [`${CF}.current_limit`]: '1' } } : { rowKey: r.rowKey, values: {} }) } }).expect(422);
    expect((await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version,
      grids: { [CF]: rows.filter(r => r.rowKey !== od.rowKey).map(r => ({ rowKey: r.rowKey, values: {} })) } }).expect(422)).body.error).toBe('read_only_row');
    // the user's own columns on a pulled row, and a new facility of their own, are fine
    const saved = (await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version, grids: {
      [CF]: [...rows.map(r => ({ rowKey: r.rowKey, values: r.rowKey === od.rowKey ? { [`${CF}.request_action`]: 'increase', [`${CF}.proposed_limit`]: '650000' } : {} })),
        { values: { [`${CF}.request_action`]: 'new', [`${CF}.proposed_limit`]: '250000', [`${CF}.limit_currency`]: 'KWD', [`${CF}.purpose_code`]: 'working_capital',
          [`${CF}.proposed_maturity_expiry`]: '2028-12-31' } }],
      'b.sp_new_collateral': [{ values: { 'b.security_package.collateral_type_reference_new_package': 'real_estate', 'b.security_package.collateral_currency_new_package': 'KWD',
        'b.security_package.collateral_current_value_new_package': '400000', 'b.security_package.collateral_request_new_package': 'add' } }],
    } }).expect(200)).body;
    expect(saved.grids[CF]).toHaveLength(4);
    version = saved.rowVersion;
  });

  it('refreshes from core banking without touching what users entered', async () => {
    const h = await as('xyz-bank', 'analyst.sara');
    const r = (await http().post(`/api/credit-requests/${id}/integrations/pull`).set(h).expect(200)).body;
    expect(r.systems.map((x: { label: string; status: string }) => `${x.label}: ${x.status}`)).toEqual(['Core banking: pulled', 'Rating system: pulled', 'Data warehouse: pulled', 'Credit bureau: pulled', 'Spreading system: pulled']);
    for (const x of r.systems) { expect(x.changes).toEqual([]); expect(x.tables).toEqual([]); }
    const d = (await http().get(`/api/credit-requests/${id}/data`).set(h).expect(200)).body;
    expect(d.grids[CF]).toHaveLength(4);
    const od = d.grids[CF].find((x: { values: Record<string, unknown> }) => x.values[`${CF}.facility_identifier_product_code_reference_number`] === 'XYZ-OD-0418823-01');
    expect(od.values[`${CF}.proposed_limit`]).toBe('650000');
    version = d.rowVersion;
    await http().post(`/api/credit-requests/${id}/integrations/pull`).set(await as('xyz-bank', 'ops.zainab')).expect(403);
  });

  it('books approved limits and collateral in core banking once, and only when approved', async () => {
    await http().post(`/api/credit-requests/${id}/core-banking/booking`).set(await as('xyz-bank', 'ops.zainab')).expect(422); // still a draft
    const step = async (user: string, action: string) => {
      const r = (await http().post(`/api/credit-requests/${id}/transitions`).set(await as('xyz-bank', user)).send({ action, expectedVersion: version }).expect(200)).body;
      version = r.request?.rowVersion ?? r.rowVersion;
    };
    await step('ro.ahmed', 'submit');
    // pulling is for requests still being prepared
    await http().post(`/api/credit-requests/${id}/integrations/pull`).set(await as('xyz-bank', 'analyst.sara')).expect(422);
    await step('analyst.sara', 'recommend');
    await step('risk.omar', 'endorse');
    await step('committee.layla', 'approve');
    await http().post(`/api/credit-requests/${id}/core-banking/booking`).set(await as('xyz-bank', 'ro.ahmed')).expect(403);
    const b = (await http().post(`/api/credit-requests/${id}/core-banking/booking`).set(await as('xyz-bank', 'ops.zainab')).expect(200)).body;
    expect(b.limits).toHaveLength(2);
    expect(b.limits).toContain('XYZ-OD-0418823-01'); // an increase keeps the existing limit reference
    expect(b.collateral).toHaveLength(1);
    const d = (await http().get(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'ops.zainab')).expect(200)).body;
    const booked = d.grids['g.facility_booking_maintenance'] as { values: Record<string, unknown> }[];
    expect(booked).toHaveLength(2);
    const inc = booked.find(r => r.values['g.facility_booking_maintenance.limit_reference'] === 'XYZ-OD-0418823-01')!;
    expect(inc.values).toMatchObject({ 'g.facility_booking_maintenance.limit_amount': '650000', 'g.facility_booking_maintenance.limit_type': 'overdraft',
      'g.facility_booking_maintenance.account_number': 'KW81XYZB0000000000001234560101', 'g.facility_booking_maintenance.action': 'increase' });
    expect(d.grids['g.collateral_booking_maintenance'][0].values['g.collateral_booking_maintenance.linked_limits']).toContain('XYZ-OD-0418823-01');
    expect(d.integration.bookedAt).toBeTruthy();
    await http().post(`/api/credit-requests/${id}/core-banking/booking`).set(await as('xyz-bank', 'ops.zainab')).expect(409);
  });

  it('reports a customer core banking does not know, and keeps the request', async () => {
    const res = await create('xyz-bank', 'ro.ahmed', 'CIF-UNKNOWN', 'KWD');
    expect(res.integration.pulled).toBe(false);
    expect(res.integration.warnings[0]).toMatch(/not found in core banking/);
    expect(res.request.borrowerName).toBe('Typed name');
  });

  it('uses the other institution\'s data and formats for ABC Finance (PAN, INR, Indian account numbers)', async () => {
    const res = await create('abc-finance', 'ro.priya', 'C10045821', 'INR');
    expect(res.integration.pulled).toBe(true);
    const d = (await http().get(`/api/credit-requests/${res.request.id}/data`).set(await as('abc-finance', 'ro.priya')).expect(200)).body;
    expect(d.record).toMatchObject({ [`${GI}customer_id_type`]: 'cin', [`${GI}customer_id_number`]: 'U34300MH2009PTC193245', [`${GI}risk_rating`]: 'ABC-3' });
    // filed statements from the company registry (MCA, Ind AS taxonomy), found by CIN, oldest period first and read-only
    const periods = d.grids['e.financial_periods'] as { rowKey: string; values: Record<string, unknown> }[];
    expect(periods.map(p => p.values['e.financial_statement_header.fiscal_year_financial_statement_date'])).toEqual(['2023-03-31', '2024-03-31', '2025-03-31']);
    expect(periods[2].values).toMatchObject({ 'e.income_statement.net_sales_revenues': '1810000000', 'e.financial_statement_header.auditor_name': 'Ravel Mehta & Associates, Chartered Accountants' });
    expect(d.integration.rows[periods[0].rowKey]).toMatchObject({ system: 'financial_statements', ref: '2023-03-31' });
    expect(d.record['e.financial_ratios_summary.gross_profit']).toBeUndefined(); // the ratios are per period, calculated from the pulled lines
    expect(periods[2].values['e.financial_ratios_summary.gross_profit']).toBe('398200000');
    const rejected = await http().put(`/api/credit-requests/${res.request.id}/data`).set(await as('abc-finance', 'ro.priya')).send({ expectedVersion: d.rowVersion,
      grids: { 'e.financial_periods': periods.map((p, i) => ({ rowKey: p.rowKey, values: i === 0 ? { 'e.income_statement.net_sales_revenues': '1' } : {} })) } }).expect(422);
    expect(rejected.body.message).toMatch(/comes from company registry/);
    // rating system, data warehouse and credit bureau for ABC
    expect(d.record).toMatchObject({ 'a.risk_ratings_borrower.internal_rating_current': 'ABC-3', 'a.capital_return_summary.existing_roc': '15.8',
      'a.relationship_overview.total_cash_limit_other_banks': '220000000' });
    expect(d.grids[CF].map((r: { values: Record<string, unknown> }) => r.values[`${CF}.settlement_account`])).toEqual(['502100045821', '502100045821']);
    // XYZ users never see ABC's customers
    await http().get(`/api/credit-requests/${res.request.id}/data`).set(await as('xyz-bank', 'ro.ahmed')).expect(404);
  });
});

describe('new customers (not yet in core banking)', () => {
  const NEW = { [`${GI}new_existing_customer`]: 'new' };
  const ID = { [`${GI}customer_id_type`]: 'commercial_registration', [`${GI}customer_id_number`]: '7781204' };
  let ro: Record<string, string> = {};
  beforeAll(async () => { ro = await as('xyz-bank', 'ro.ahmed'); });
  const post = (body: Record<string, unknown>) => http().post('/api/credit-requests').set(ro)
    .send({ borrowerName: 'Halvorn Desalination K.S.C.', requestType: 'new', requestedAmount: '100000', currencyCode: 'KWD', ...body });

  it('needs the customer number for an existing customer, and the ID type and number for a new one', async () => {
    const existing = (await post({ fields: { [`${GI}new_existing_customer`]: 'existing' } }).expect(422)).body;
    expect(existing.error).toBe('required_fields');
    expect(existing.details.missing.map((x: { field: string }) => x.field)).toEqual(['borrower_ref']);
    const unset = (await post({}).expect(422)).body; // not said: treated as existing
    expect(unset.details.missing.map((x: { field: string }) => x.field)).toEqual(['borrower_ref']);
    const noId = (await post({ fields: NEW }).expect(422)).body;
    expect(noId.details.missing.map((x: { field: string }) => x.field).sort()).toEqual([`${GI}customer_id_number`, `${GI}customer_id_type`]);
  });

  it('can make the customer number required for every request (tenant setting, maker-checker)', async () => {
    const set = async (value: string) => {
      const r = (await http().put('/api/config/parameters/credit_request.customer_number_required').set(await as('xyz-bank', 'admin.fatima')).send({ value }).expect(200)).body;
      await http().post(`/api/config/changes/${r.changeId}/decision`).set(await as('xyz-bank', 'admin.yusuf')).send({ approve: true }).expect(200);
    };
    await http().put('/api/config/parameters/credit_request.customer_number_required').set(await as('xyz-bank', 'admin.fatima')).send({ value: 'sometimes' }).expect(422);
    await http().put('/api/config/parameters/credit_request.new_customer_code').set(await as('xyz-bank', 'admin.fatima')).send({ value: 'prospect' }).expect(422);
    await set('always');
    const r = (await post({ fields: { ...NEW, ...ID } }).expect(422)).body;
    expect(r.details.missing.map((x: { field: string }) => x.field)).toEqual(['borrower_ref']);
    await set('existing_customers');
  });

  it('opens the request without a customer number; core banking creates the customer when it is booked', async () => {
    const res = (await post({ fields: { ...NEW, ...ID } }).expect(201)).body;
    expect(res.request.borrowerRef).toBeNull();
    const id = res.request.id as string;
    const h = await as('xyz-bank', 'ro.ahmed');
    let d = (await http().get(`/api/credit-requests/${id}/data`).set(h).expect(200)).body;
    expect(d.record).toMatchObject({ ...NEW, ...ID });
    d = (await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: d.rowVersion, grids: { [CF]: [{ values: {
      [`${CF}.request_action`]: 'new', [`${CF}.proposed_limit`]: '300000', [`${CF}.limit_currency`]: 'KWD', [`${CF}.proposed_maturity_expiry`]: '2029-06-30' } }] } }).expect(200)).body;
    let version = d.rowVersion as number;
    for (const [user, action] of [['ro.ahmed', 'submit'], ['analyst.sara', 'recommend'], ['risk.omar', 'endorse'], ['committee.layla', 'approve']]) {
      const r = (await http().post(`/api/credit-requests/${id}/transitions`).set(await as('xyz-bank', user)).send({ action, expectedVersion: version }).expect(200)).body;
      version = r.request?.rowVersion ?? r.rowVersion;
    }
    const b = (await http().post(`/api/credit-requests/${id}/core-banking/booking`).set(await as('xyz-bank', 'ops.zainab')).expect(200)).body;
    expect(b).toMatchObject({ customerCreated: true });
    expect(b.customer).toMatch(/^CIF\d{8}$/);
    expect(b.limits).toHaveLength(1);
    const after = (await http().get(`/api/credit-requests/${id}`).set(h).expect(200)).body;
    expect(after.borrowerRef).toBe(b.customer);
    // the new customer is now known to core banking
    const c = (await http().get(`/api/integrations/core-banking/customers/${b.customer}`).set(h).expect(200)).body;
    expect(c).toMatchObject({ name: 'Halvorn Desalination K.S.C.', idType: 'commercial_registration', idNumber: '7781204' });
  });
});
