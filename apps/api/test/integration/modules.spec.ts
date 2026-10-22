/**
 * Phase 2 — Credit Request module screens: layout from configuration, module data in the typed value store,
 * calculated fields, validation, governance of formulas, submission checks. CI runs this on PostgreSQL,
 * Microsoft SQL Server and Oracle.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { createDataSource } from '../../src/database/data-source';
import { loadDbEnv } from '../../src/config/env';
import { seedAll } from '../../src/database/seed';
import { ConfigParameter } from '../../src/modules/configuration/configuration.entities';
import { Tenant } from '../../src/modules/tenancy/tenancy.entities';

let app: INestApplication;
let ds: DataSource;
const http = () => request(app.getHttpServer());
const tokens = new Map<string, string>();
async function as(tenantCode: string, loginName: string) {
  const k = `${tenantCode}/${loginName}`;
  if (!tokens.has(k)) tokens.set(k, (await http().post('/api/auth/dev-login').send({ tenantCode, loginName }).expect(200)).body.token);
  return { Authorization: `Bearer ${tokens.get(k)}` };
}

const IS = 'e.income_statement.';
const BA = 'e.balance_sheet_assets.';
const BL = 'e.balance_sheet_liabilities_net_worth.';
const FR = 'e.financial_ratios_summary.';
const SP = 'b.security_package.';
const PERIODS = 'e.financial_periods';

interface Section { code: string; kind: string; grid: string | null; fields: Meta[]; columns: Meta[] }
interface Meta { key: string; label: string; readOnly: boolean; list?: string; calc?: { status: string }; bind?: string; valueKind: string }
interface Layout { modules: { code: string; title: string; sections: Section[] }[]; lists: Record<string, { code: string; label: string }[]>; baseCurrency: string }
const allFields = (l: Layout) => l.modules.flatMap(m => m.sections.flatMap(s => [...s.fields, ...s.columns]));

beforeAll(async () => {
  const setup = createDataSource(loadDbEnv());
  await setup.initialize();
  await setup.dropDatabase();
  await setup.runMigrations();
  await seedAll(setup);
  await setup.destroy();
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1'); // one listening server: requests below are built while other requests are in flight
  ds = app.get(DataSource);
});
afterAll(async () => { await app?.close(); });

async function newRequest(tenant: string, ro: string, currencyCode: string, requestType = 'new') {
  const res = await http().post('/api/credit-requests').set(await as(tenant, ro)).send({ borrowerName: 'Harbour Logistics', borrowerRef: 'C-2001',
    requestType, requestedAmount: '100000', currencyCode }).expect(201);
  return res.body.request as { id: string; rowVersion: number };
}

describe('layout from configuration', () => {
  it('returns the seven modules with tenant value lists and calculated-field metadata', async () => {
    const xyz = (await http().get('/api/layout').set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body as Layout;
    expect(xyz.modules.map(m => m.title)).toEqual(['Borrower Profile', 'Facility & Collateral', 'Exposure & Relationship', 'Business Profile',
      'Financial Analysis', 'ESG & Sustainability', 'Credit Administration']);
    expect(xyz.baseCurrency).toBe('KWD');
    const fields = allFields(xyz);
    expect(fields.length).toBeGreaterThan(600);
    const margin = fields.find(f => f.key === `${FR}gross_profit_margin`)!;
    expect(margin.readOnly).toBe(true);
    expect(margin.calc?.status).toBe('active');
    expect(fields.find(f => f.key === `${FR}breakeven_sales`)!.calc?.status).toBe('pending');
    expect(fields.find(f => f.key === 'a.general_information.name_of_borrower')!.bind).toBe('borrowerName');
    const periods = xyz.modules.find(m => m.code === 'financial_analysis')!.sections.filter(s => s.kind === 'periods');
    expect(new Set(periods.map(s => s.grid))).toEqual(new Set([PERIODS]));
    // same field, each tenant's own rating scale
    const abc = (await http().get('/api/layout').set(await as('abc-finance', 'ro.priya')).expect(200)).body as Layout;
    expect(xyz.lists.internal_rating[0].label).toBe('Grade 1');
    expect(abc.lists.internal_rating[0].label).toBe('ABC-1');
  });

  it('reflects tenant overrides and custom fields without a code change', async () => {
    const admin = await as('abc-finance', 'admin.anita');
    await http().put('/api/fields/a.general_information.company_website/override').set(admin).send({ hidden: true }).expect(200);
    await http().put('/api/fields/a.general_information.borrower_since/override').set(admin).send({ labelOverride: 'Customer since' }).expect(200);
    await http().post('/api/fields/custom/x.msme_registration').set(admin).send({ label: 'MSME Registration Number', module: 'Borrower Profile',
      group: 'General Information', dataType: 'Text (identifier)' }).expect(201);
    const abc = (await http().get('/api/layout').set(await as('abc-finance', 'ro.priya')).expect(200)).body as Layout;
    const general = abc.modules[0].sections.find(s => s.code === 'a.general_information')!;
    expect(general.fields.some(f => f.key === 'a.general_information.company_website')).toBe(false);
    expect(general.fields.find(f => f.key === 'a.general_information.borrower_since')!.label).toBe('Customer since');
    expect(general.fields.some(f => f.key === 'x.msme_registration')).toBe(true);
    const xyz = (await http().get('/api/layout').set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body as Layout;
    expect(allFields(xyz).some(f => f.key === 'a.general_information.company_website')).toBe(true);
    expect(allFields(xyz).some(f => f.key === 'x.msme_registration')).toBe(false);
  });
});

describe('module data', () => {
  let id = '';
  let version = 0;
  let periodKeys: string[] = [];

  it('saves record values and computes financial ratios per period, exactly', async () => {
    const r = await newRequest('xyz-bank', 'ro.ahmed', 'KWD');
    id = r.id;
    const p1 = { [`${IS}net_sales_revenues`]: '1000000', [`${IS}cost_of_sales_revenues`]: '600000', [`${IS}general_administrative_expense`]: '150000',
      [`${IS}net_operating_profit`]: '250000', [`${IS}interest_expense`]: '50000', [`${IS}depreciation`]: '30000', [`${IS}amortization`]: '5000',
      [`${BA}accounts_receivable_net`]: '120000', [`${BA}total_inventory`]: '90000', [`${BA}total_current_assets`]: '400000', [`${BA}total_assets`]: '1500000',
      [`${BA}cash`]: '40000', [`${BA}time_deposits`]: '10000', [`${BL}total_current_liabilities`]: '250000', [`${BL}total_liabilities`]: '900000',
      [`${BL}total_net_worth`]: '600000', [`${BL}accounts_payable_trade`]: '60000', [`${BL}short_term_loans_payable_bank`]: '100000',
      [`${BL}current_portion_of_long_term_debt_cpltd_bank`]: '50000', [`${BL}long_term_debt_bank`]: '300000',
      'e.financial_statement_header.fiscal_year_financial_statement_date': '2024-12-31' };
    const p2 = { [`${IS}net_sales_revenues`]: '1200000', [`${IS}cost_of_sales_revenues`]: '700000', [`${IS}net_operating_profit`]: '300000',
      'e.financial_statement_header.fiscal_year_financial_statement_date': '2025-12-31' };
    const res = await http().put(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'ro.ahmed')).send({ expectedVersion: r.rowVersion,
      record: { 'a.general_information.legal_entity': 'xyz_bank', 'a.client_request.client_request_details': 'Fleet expansion',
        'a.general_information.requires_syndication_desk_involvement': false, 'a.general_information.establishment_date': '2009-04-01',
        'b.interest_tiering_brackets.tiering_bracket_1:from': '0', 'b.interest_tiering_brackets.tiering_bracket_1:rate': '4.125' },
      grids: { [PERIODS]: [{ values: p1 }, { values: p2 }] } }).expect(200);
    const body = res.body;
    expect(body.rowVersion).toBe(r.rowVersion + 1);
    expect(body.record['a.general_information.establishment_date']).toBe('2009-04-01');
    expect(body.record['a.general_information.requires_syndication_desk_involvement']).toBe(false);
    expect(body.record['a.general_information.name_of_borrower']).toBe('Harbour Logistics'); // bound to the header
    expect(body.record['b.interest_tiering_brackets.tiering_bracket_1:rate']).toBe('4.125');
    const [y1, y2] = body.grids[PERIODS].map((p: { values: Record<string, string> }) => p.values);
    periodKeys = body.grids[PERIODS].map((p: { rowKey: string }) => p.rowKey);
    expect(y1[`${FR}gross_profit`]).toBe('400000');
    expect(y1[`${FR}current_ratio`]).toBe('1.6');
    expect(y1[`${FR}quick_ratio`]).toBe('1.24');
    expect(y1[`${FR}accounts_receivable_days_doh`]).toBe('44');      // 43.8 → whole days
    expect(y1[`${FR}inventory_days_doh`]).toBe('55');                // 54.75
    expect(y1[`${FR}accounts_payable_accruals_days_doh`]).toBe('37'); // 36.5, tenant rounding mode half_up
    expect(y1[`${FR}cash_conversion_cycle_days`]).toBe('62');
    expect(y1[`${FR}interest_bearing_debt`]).toBe('450000');
    expect(y1[`${FR}gearing`]).toBe('0.75');
    expect(y1[`${FR}ebitda`]).toBe('285000');
    expect(y1[`${FR}net_debt_ebitda`]).toBe('1.40350877');
    expect(y1[`${FR}interest_coverage_ebitda`]).toBe('5.7');
    expect(y1[`${FR}sales_growth_rate`]).toBeUndefined();          // no earlier period
    expect(y2[`${FR}gross_profit_margin`]).toBe('41.66666667');
    expect(y2[`${FR}sales_growth_rate`]).toBe('20');
    expect(y2[`${FR}nop_growth_rate`]).toBe('20');
    expect(y2[`${FR}current_ratio`]).toBeUndefined();              // inputs missing → empty, never guessed
    version = body.rowVersion;
  });

  it('converts security-package lines to the base currency at the configured rates', async () => {
    const res = await http().put(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'analyst.sara')).send({ expectedVersion: version, grids: {
      'b.sp_existing_facilities': [{ values: { [`${SP}facility_value_existing_package`]: '200000', [`${SP}facility_currency_existing_package`]: 'KWD' } }],
      'b.sp_existing_collateral': [
        { values: { [`${SP}current_collateral_assigned_value_existing_package`]: '500000', [`${SP}collateral_currency_existing_package`]: 'USD' } },
        { values: { [`${SP}current_collateral_assigned_value_existing_package`]: '100000', [`${SP}collateral_currency_existing_package`]: 'KWD' } },
      ] } }).expect(200);
    const rec = res.body.record;
    expect(rec[`${SP}total_existing_collateral_value_base_reporting_currency_existing_package`]).toBe('253500'); // 500,000 USD × 0.307 + 100,000
    expect(rec[`${SP}total_existing_facility_value_base_reporting_currency_existing_package`]).toBe('200000');
    expect(rec[`${SP}actual_coverage_ratio_existing_package`]).toBe('1.2675');
    expect(res.body.grids['b.sp_existing_collateral'].map((r: { values: Record<string, string> }) => r.values[`${SP}of_total_existing_package`]))
      .toEqual(['60.55226824', '39.44773176']);
    expect(res.body.grids[PERIODS]).toHaveLength(2); // grids not sent are kept
    version = res.body.rowVersion;
  });

  it('replaces a grid: removed rows and their values are deleted, order follows the list', async () => {
    const h = await as('xyz-bank', 'ro.ahmed');
    const cur = (await http().get(`/api/credit-requests/${id}/data`).set(h).expect(200)).body;
    const [first, second] = cur.grids[PERIODS];
    const res = await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version,
      grids: { [PERIODS]: [{ rowKey: second.rowKey, values: {} }] } }).expect(200);
    expect(res.body.grids[PERIODS].map((r: { rowKey: string }) => r.rowKey)).toEqual([second.rowKey]);
    expect(res.body.grids[PERIODS][0].values[`${FR}sales_growth_rate`]).toBeUndefined(); // it is now the first period
    expect(first.rowKey).toBe(periodKeys[0]);
    version = res.body.rowVersion;
  });

  it('rejects invalid input with a precise reason', async () => {
    const h = await as('xyz-bank', 'ro.ahmed');
    const put = (body: object) => http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version, ...body });
    expect((await put({ record: { [`${SP}actual_coverage_ratio_existing_package`]: '1' } }).expect(422)).body.error).toBe('read_only_field');   // calculated
    expect((await put({ record: { 'a.general_information.name_of_borrower': 'X' } }).expect(422)).body.error).toBe('read_only_field'); // header-bound
    expect((await put({ record: { 'a.nope': 'x' } }).expect(422)).body.error).toBe('unknown_field');
    expect((await put({ record: { [`${IS}net_sales_revenues`]: '1' } }).expect(422)).body.error).toBe('unknown_field'); // a grid column
    expect((await put({ record: { 'a.general_information.legal_entity': 'not_a_code' } }).expect(422)).body.error).toBe('invalid_value');
    expect((await put({ record: { 'a.general_information.profitability': 12.5 } }).expect(422)).body.error).toBe('invalid_value'); // numbers must be text
    expect((await put({ record: { 'a.general_information.establishment_date': '2024-02-30' } }).expect(422)).body.error).toBe('invalid_value');
    expect((await put({ grids: { 'b.sp_existing_facilities': [{ values: { [`${SP}facility_currency_existing_package`]: 'JPY' } }] } }).expect(422)).body.error)
      .toBe('invalid_value'); // currency not enabled for XYZ
    expect((await put({ grids: { 'a.partners': [{ rowKey: periodKeys[1], values: {} }] } }).expect(422)).body.error).toBe('unknown_row');
    expect((await put({ grids: { 'z.unknown': [] } }).expect(422)).body.error).toBe('unknown_grid');
    expect((await http().put(`/api/credit-requests/${id}/data`).set(h).send({ expectedVersion: version - 1, record: {} }).expect(409)).body.error).toBe('conflict');
    await http().put(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'committee.layla')).send({ expectedVersion: version, record: {} }).expect(403);
  });

  it('isolates tenants and audits every save in the hash chain', async () => {
    await http().get(`/api/credit-requests/${id}/data`).set(await as('abc-finance', 'ro.priya')).expect(404);
    const auditor = await as('xyz-bank', 'auditor.hana');
    const events = (await http().get('/api/audit?limit=20').set(auditor).expect(200)).body as { action: string; after: string }[];
    expect(events.filter(e => e.action === 'credit_request_data_updated').length).toBeGreaterThanOrEqual(3);
    expect((await http().get('/api/audit/verify').set(auditor).expect(200)).body.valid).toBe(true);
  });

  it('warns about missing mandatory fields at submission (XYZ: warn)', async () => {
    const res = await http().post(`/api/credit-requests/${id}/transitions`).set(await as('xyz-bank', 'ro.ahmed'))
      .send({ action: 'submit', expectedVersion: version }).expect(200);
    expect(res.body.status).toBe('credit_review');
    expect(res.body.warnings[0]).toMatch(/mandatory field\(s\) are not filled in/);
    const data = (await http().get(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'ro.ahmed')).expect(200)).body;
    expect(data.editable).toBe(false);
    expect(data.completeness.mode).toBe('warn');
    await http().put(`/api/credit-requests/${id}/data`).set(await as('xyz-bank', 'ro.ahmed')).send({ expectedVersion: data.rowVersion, record: {} }).expect(422);
  });

  it('blocks submission with missing mandatory fields when the tenant chooses block (ABC)', async () => {
    const admin = await as('abc-finance', 'admin.anita');
    await http().put('/api/config/parameters/credit_request.mandatory_fields_on_submit').set(admin).send({ value: 'strict' }).expect(422);
    await http().put('/api/config/parameters/credit_request.mandatory_fields_on_submit').set(admin).send({ value: 'block' }).expect(200);
    const r = await newRequest('abc-finance', 'ro.priya', 'INR');
    const ro = await as('abc-finance', 'ro.priya');
    const res = await http().post(`/api/credit-requests/${r.id}/transitions`).set(ro).send({ action: 'submit', expectedVersion: r.rowVersion }).expect(422);
    expect(res.body.error).toBe('mandatory_fields');
    const missing = res.body.details.missing as { key: string; module: string }[];
    expect(missing.some(x => x.key === 'd.swot_analysis.strengths')).toBe(true);
    const data = (await http().get(`/api/credit-requests/${r.id}/data`).set(ro).expect(200)).body;
    expect(data.completeness.missing).toHaveLength(missing.length);
    expect(data.completeness.modules.business_profile.filled).toBe(0);
    // the custom field and the hidden field behave as configured
    await http().put(`/api/credit-requests/${r.id}/data`).set(ro).send({ expectedVersion: r.rowVersion,
      record: { 'x.msme_registration': 'UDYAM-MH-00-0000001' } }).expect(200);
    expect((await http().put(`/api/credit-requests/${r.id}/data`).set(ro).send({ expectedVersion: r.rowVersion + 1,
      record: { 'a.general_information.company_website': 'x' } }).expect(422)).body.error).toBe('unknown_field');
  });
});

describe('formulas are governed configuration', () => {
  it('lets a tenant replace a core formula for itself only, and rejects invalid formulas', async () => {
    const admin = await as('abc-finance', 'admin.anita');
    const key = `${FR}cogs_sales`;
    await http().put(`/api/formulas/${key}`).set(admin).send({ description: 'COGS as a percentage of sales',
      expression: { pct: [{ f: `${FR}cost_of_goods_sold_cogs` }, { f: `${FR}revenue_sales` }] } }).expect(200);
    const circular = await http().put(`/api/formulas/${FR}current_ratio`).set(admin).send({ description: 'x',
      expression: { div: [{ f: `${FR}current_ratio` }, { n: '2' }] } }).expect(422);
    expect(circular.body.message).toMatch(/Circular/);
    await http().put(`/api/formulas/${FR}current_ratio`).set(admin).send({ description: 'x', expression: { cfg: 'credit_request.max_single_request' } })
      .expect(200); // decimal parameter — allowed
    const missingParam = await http().put(`/api/formulas/${FR}quick_ratio`).set(admin).send({ description: 'x', expression: { cfg: 'no.such.param' } }).expect(422);
    expect(missingParam.body.error).toBe('invalid_formula');
    const r = await newRequest('abc-finance', 'ro.priya', 'INR', 'renewal');
    const res = await http().put(`/api/credit-requests/${r.id}/data`).set(await as('abc-finance', 'ro.priya')).send({ expectedVersion: r.rowVersion,
      grids: { [PERIODS]: [{ values: { [`${IS}net_sales_revenues`]: '800', [`${IS}cost_of_sales_revenues`]: '200' } }] } }).expect(200);
    expect(res.body.grids[PERIODS][0].values[key]).toBe('25');
    const list = (await http().get('/api/formulas').set(admin).expect(200)).body as { fieldKey: string; scope: string }[];
    expect(list.find(f => f.fieldKey === key)!.scope).toBe('tenant');
    const xyzList = (await http().get('/api/formulas').set(await as('xyz-bank', 'admin.fatima')).expect(200)).body as { fieldKey: string; scope: string }[];
    expect(xyzList.find(f => f.fieldKey === key)!.scope).toBe('core');
  });
});

describe('release configuration for existing tenants', () => {
  it('adds new parameters to an existing tenant without overwriting its own values', async () => {
    const abc = await ds.getRepository(Tenant).findOneByOrFail({ code: 'abc-finance' });
    await ds.getRepository(ConfigParameter).delete({ tenantId: abc.id, paramKey: 'calculation.days_in_year' });
    const result = await seedAll(ds);
    expect(result.tenants['abc-finance']).toMatch(/added 1 configuration item/);
    expect(result.tenants['xyz-bank']).toBe('exists');
    const params = await ds.getRepository(ConfigParameter).find({ where: { tenantId: abc.id } });
    expect(params.find(p => p.paramKey === 'calculation.days_in_year')!.paramValue).toBe('365');
    expect(params.find(p => p.paramKey === 'credit_request.mandatory_fields_on_submit')!.paramValue).toBe('block'); // the tenant's change stays
  });
});
