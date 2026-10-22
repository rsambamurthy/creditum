/**
 * End-to-end checks of the Phase 0 foundation against a real database. CI runs this same suite on
 * PostgreSQL, Microsoft SQL Server and Oracle (DB_TYPE + connection variables).
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
import { AuditEvent } from '../../src/modules/audit/audit.entities';
import { FieldValue } from '../../src/modules/field-registry/field-registry.entities';
import { FxRate } from '../../src/modules/configuration/configuration.entities';
import { Tenant } from '../../src/modules/tenancy/tenancy.entities';
import { newId } from '../../src/common/tenant';

const NARRATIVE = 'a.client_request.client_request_details';
let app: INestApplication;
let ds: DataSource;
const http = () => request(app.getHttpServer());

async function login(tenantCode: string, loginName: string): Promise<string> {
  const res = await http().post('/api/auth/dev-login').send({ tenantCode, loginName }).expect(200);
  return res.body.token;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const setup = createDataSource(loadDbEnv());
  await setup.initialize();
  await setup.dropDatabase();
  await setup.runMigrations();
  await seedAll(setup);
  await setup.destroy();
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.init();
  ds = app.get(DataSource);
});

afterAll(async () => { await app?.close(); });

describe('schema and storage', () => {
  it('migrations match the entities exactly (no drift)', async () => {
    const sql = await ds.driver.createSchemaBuilder().log();
    expect(sql.upQueries.map(q => q.query)).toEqual([]);
  });

  it('round-trips 28-digit decimals exactly — never through floating point', async () => {
    const tenant = await ds.getRepository(Tenant).findOneByOrFail({ code: 'xyz-bank' });
    const id = newId();
    await ds.getRepository(FieldValue).insert({ id, tenantId: tenant.id, entityType: 'probe', entityId: newId(), fieldKey: 'probe', rowKey: 'record',
      valueText: null, valueDecimal: '12345678901234567890.12345678', valueDate: null, valueBool: true });
    const back = await ds.getRepository(FieldValue).findOneByOrFail({ id, tenantId: tenant.id });
    expect(back.valueDecimal).toBe('12345678901234567890.12345678');
    expect(back.valueBool).toBe(true);
    const fx = newId();
    await ds.getRepository(FxRate).insert({ id: fx, tenantId: tenant.id, fromCode: 'AAA', toCode: 'BBB', rate: '0.123456789012', asOf: new Date() });
    expect((await ds.getRepository(FxRate).findOneByOrFail({ id: fx, tenantId: tenant.id })).rate).toBe('0.123456789012');
    await ds.getRepository(FxRate).delete({ id: fx, tenantId: tenant.id });
    await ds.getRepository(FieldValue).delete({ id, tenantId: tenant.id });
  });
});

describe('security baseline', () => {
  it('health is public; everything else needs sign-in', async () => {
    await http().get('/api/health').expect(200);
    await http().get('/api/fields').expect(401);
    await http().get('/api/fields').set({ Authorization: 'Bearer not-a-token' }).expect(401);
  });
  it('sets security headers and hides the framework', async () => {
    const res = await http().get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
  it('rejects unknown properties in requests', async () => {
    const t = await login('xyz-bank', 'ro.ahmed');
    await http().post('/api/credit-requests').set(auth(t)).send({ borrowerName: 'A', borrowerRef: 'B', requestType: 'new', requestedAmount: '10',
      currencyCode: 'KWD', isAdmin: true }).expect(400);
  });
  it('enforces roles', async () => {
    const ro = await login('xyz-bank', 'ro.ahmed');
    await http().put('/api/config/parameters/credit_request.max_single_request').set(auth(ro)).send({ value: '1' }).expect(403);
    await http().get('/api/audit').set(auth(ro)).expect(403);
  });
});

describe('configuration-first behaviour across two tenants', () => {
  let xyzRequestId = '';

  it('uses each tenant’s currency scale: 3 decimals allowed for XYZ (KWD), rejected for ABC (INR)', async () => {
    const xyz = await login('xyz-bank', 'ro.ahmed');
    const ok = await http().post('/api/credit-requests').set(auth(xyz)).send({ borrowerName: 'Gulf Trading Co', borrowerRef: 'C-1001', requestType: 'new',
      requestedAmount: '150000.125', currencyCode: 'KWD' }).expect(201);
    expect(ok.body.request.requestNumber).toMatch(/^CR-\d{4}-\d{6}$/);
    expect(ok.body.request.requestedAmount).toBe('150000.125');
    expect(ok.body.request.requiredLevel).toBe('L1');
    const abc = await login('abc-finance', 'ro.priya');
    const bad = await http().post('/api/credit-requests').set(auth(abc)).send({ borrowerName: 'Pune Castings', borrowerRef: 'B-77', requestType: 'new',
      requestedAmount: '150000.125', currencyCode: 'INR' }).expect(422);
    expect(bad.body.error).toBe('amount_scale');
  });

  it('applies configured thresholds: same rule logic, different limits per tenant', async () => {
    const xyz = await login('xyz-bank', 'ro.ahmed');
    const need = await http().post('/api/credit-requests').set(auth(xyz)).send({ borrowerName: 'Gulf Trading Co', borrowerRef: 'C-1001',
      requestType: 'increase', requestedAmount: '1250000', currencyCode: 'KWD' }).expect(422);
    expect(need.body.error).toBe('required_fields');
    const ok = await http().post('/api/credit-requests').set(auth(xyz)).send({ borrowerName: 'Gulf Trading Co', borrowerRef: 'C-1001',
      requestType: 'increase', requestedAmount: '1250000', currencyCode: 'KWD', fields: { [NARRATIVE]: 'Working capital for new contract' } }).expect(201);
    expect(ok.body.request.requiredLevel).toBe('L2');
    expect(ok.body.request.fields[NARRATIVE]).toBe('Working capital for new contract');
    xyzRequestId = ok.body.request.id;
    const blocked = await http().post('/api/credit-requests').set(auth(xyz)).send({ borrowerName: 'X', borrowerRef: 'Y', requestType: 'new',
      requestedAmount: '60000000', currencyCode: 'KWD', fields: { [NARRATIVE]: 'n' } }).expect(422);
    expect(blocked.body.error).toBe('rule_blocked');
    // 1,250,000 INR is far below ABC's narrative threshold and within its first authority level
    const abc = await login('abc-finance', 'ro.priya');
    const abcOk = await http().post('/api/credit-requests').set(auth(abc)).send({ borrowerName: 'Pune Castings', borrowerRef: 'B-77',
      requestType: 'new', requestedAmount: '1250000', currencyCode: 'INR' }).expect(201);
    expect(abcOk.body.request.requiredLevel).toBe('L1');
    expect(abcOk.body.request.requestNumber).toMatch(/^LA\/\d{4}\/\d{5}$/);
  });

  it('converts foreign-currency requests to the base currency with the configured rate', async () => {
    const xyz = await login('xyz-bank', 'ro.ahmed');
    const res = await http().post('/api/credit-requests').set(auth(xyz)).send({ borrowerName: 'Gulf Trading Co', borrowerRef: 'C-1001', requestType: 'new',
      requestedAmount: '1000000', currencyCode: 'USD', fields: { [NARRATIVE]: 'USD trade line' } }).expect(201);
    expect(res.body.request.baseAmount).toBe('307000');
    expect(res.body.request.fxRateUsed).toBe('0.307');
    expect(res.body.request.requiredLevel).toBe('L2');
    await http().post('/api/credit-requests').set(auth(xyz)).send({ borrowerName: 'A', borrowerRef: 'B', requestType: 'new',
      requestedAmount: '10', currencyCode: 'JPY' }).expect(422);
  });

  it('isolates tenants', async () => {
    const abc = await login('abc-finance', 'analyst.arjun');
    await http().get(`/api/credit-requests/${xyzRequestId}`).set(auth(abc)).expect(404);
    const list = await http().get('/api/credit-requests').set(auth(abc)).expect(200);
    expect(list.body.every((r: { requestNumber: string }) => r.requestNumber.startsWith('LA/'))).toBe(true);
  });

  it('rejects stale updates (optimistic locking)', async () => {
    const ro = await login('xyz-bank', 'ro.ahmed');
    const first = await http().put(`/api/credit-requests/${xyzRequestId}`).set(auth(ro)).send({ expectedVersion: 1, borrowerName: 'Gulf Trading Company' }).expect(200);
    expect(first.body.request.rowVersion).toBe(2);
    const stale = await http().put(`/api/credit-requests/${xyzRequestId}`).set(auth(ro)).send({ expectedVersion: 1, borrowerName: 'Overwrite' }).expect(409);
    expect(stale.body.error).toBe('conflict');
  });

  it('routes through the configured workflow and enforces delegated authority', async () => {
    const ro = await login('xyz-bank', 'ro.ahmed');
    let r = (await http().post(`/api/credit-requests/${xyzRequestId}/transitions`).set(auth(ro)).send({ action: 'submit', expectedVersion: 2 }).expect(200)).body;
    expect(r.status).toBe('credit_review');
    await http().put(`/api/credit-requests/${xyzRequestId}`).set(auth(ro)).send({ expectedVersion: 3, borrowerName: 'Late edit' }).expect(422);
    const analyst = await login('xyz-bank', 'analyst.sara');
    r = (await http().post(`/api/credit-requests/${xyzRequestId}/transitions`).set(auth(analyst)).send({ action: 'recommend', expectedVersion: 3 }).expect(200)).body;
    const risk = await login('xyz-bank', 'risk.omar');
    r = (await http().post(`/api/credit-requests/${xyzRequestId}/transitions`).set(auth(risk)).send({ action: 'endorse', expectedVersion: 4 }).expect(200)).body;
    expect(r.status).toBe('committee');
    const l1 = await login('xyz-bank', 'committee.layla');
    const denied = await http().post(`/api/credit-requests/${xyzRequestId}/transitions`).set(auth(l1)).send({ action: 'approve', expectedVersion: 5 }).expect(403);
    expect(denied.body.message).toMatch(/authority/);
    const l2 = await login('xyz-bank', 'senior.khalid');
    const view = (await http().get(`/api/credit-requests/${xyzRequestId}`).set(auth(l2)).expect(200)).body;
    expect(view.actions.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['approve', 'decline', 'send_back']));
    await http().post(`/api/credit-requests/${xyzRequestId}/transitions`).set(auth(l2)).send({ action: 'decline', expectedVersion: 5 }).expect(422);
    r = (await http().post(`/api/credit-requests/${xyzRequestId}/transitions`).set(auth(l2)).send({ action: 'approve', expectedVersion: 5 }).expect(200)).body;
    expect(r.status).toBe('approved');
    const history = (await http().get(`/api/credit-requests/${xyzRequestId}/history`).set(auth(l2)).expect(200)).body;
    expect(history.map((h: { actionCode: string }) => h.actionCode)).toEqual(['submit', 'recommend', 'endorse', 'approve']);
  });

  it('enforces tenant-specific rules at submission (ABC enhancement needs details)', async () => {
    const ro = await login('abc-finance', 'ro.priya');
    const created = (await http().post('/api/credit-requests').set(auth(ro)).send({ borrowerName: 'Pune Castings', borrowerRef: 'B-77',
      requestType: 'increase', requestedAmount: '500000', currencyCode: 'INR' }).expect(201)).body.request;
    const res = await http().post(`/api/credit-requests/${created.id}/transitions`).set(auth(ro)).send({ action: 'submit', expectedVersion: 1 }).expect(422);
    expect(res.body.error).toBe('required_fields');
  });
});

describe('configuration governance and the field registry', () => {
  it('XYZ: a parameter change waits for a second administrator; the maker cannot approve it', async () => {
    const maker = await login('xyz-bank', 'admin.fatima');
    const sub = await http().put('/api/config/parameters/credit_request.narrative_required_above').set(auth(maker)).send({ value: '300000' }).expect(200);
    expect(sub.body.status).toBe('pending');
    let params = (await http().get('/api/config/parameters').set(auth(maker))).body;
    expect(params.find((p: { paramKey: string }) => p.paramKey === 'credit_request.narrative_required_above').paramValue).toBe('250000');
    await http().post(`/api/config/changes/${sub.body.changeId}/decision`).set(auth(maker)).send({ approve: true }).expect(403);
    const checker = await login('xyz-bank', 'admin.yusuf');
    await http().post(`/api/config/changes/${sub.body.changeId}/decision`).set(auth(checker)).send({ approve: true }).expect(200);
    params = (await http().get('/api/config/parameters').set(auth(maker))).body;
    expect(params.find((p: { paramKey: string }) => p.paramKey === 'credit_request.narrative_required_above').paramValue).toBe('300000');
    await http().put('/api/config/parameters/credit_request.max_single_request').set(auth(maker)).send({ value: 'lots' }).expect(422);
  });

  it('ABC: maker-checker is off by configuration, so changes apply immediately (and are audited)', async () => {
    const admin = await login('abc-finance', 'admin.anita');
    const res = await http().put('/api/config/parameters/request_number.padding').set(auth(admin)).send({ value: '6' }).expect(200);
    expect(res.body.status).toBe('applied');
    await http().put('/api/config/parameters/request_number.padding').set(auth(admin)).send({ value: 'six' }).expect(422);
  });

  it('changes a field label for one tenant without touching the other or the core library', async () => {
    const admin = await login('abc-finance', 'admin.anita');
    await http().put(`/api/fields/${NARRATIVE}/override`).set(auth(admin)).send({ labelOverride: 'Purpose of Loan', requirementOverride: 'Mandatory' }).expect(200);
    const abcField = (await http().get('/api/fields').set(auth(admin))).body.find((f: { fieldKey: string }) => f.fieldKey === NARRATIVE);
    expect(abcField.label).toBe('Purpose of Loan');
    expect(abcField.coreLabel).toBe('Client Request Details');
    const xyz = await login('xyz-bank', 'admin.fatima');
    const xyzFields = (await http().get('/api/fields').set(auth(xyz))).body;
    expect(xyzFields.find((f: { fieldKey: string }) => f.fieldKey === NARRATIVE).label).toBe('Client Request Details');
    expect(xyzFields.length).toBeGreaterThanOrEqual(703);
  });

  it('adds a tenant custom field and a tenant rule using it — configuration only', async () => {
    const admin = await login('abc-finance', 'admin.anita');
    await http().post('/api/fields/custom/x.msme_udyam_number').set(auth(admin)).send({ label: 'MSME Registration Number', module: 'Borrower Profile',
      group: 'General Information', dataType: 'Text (identifier)' }).expect(201);
    await http().put('/api/rules/ABC-002').set(auth(admin)).send({ name: 'MSME number required for new loans', triggerOn: 'on_save',
      condition: { '==': [{ var: 'request_type' }, 'new'] }, actions: [{ type: 'require', field: 'x.msme_udyam_number', message: 'MSME registration number is required' }] }).expect(200);
    const ro = await login('abc-finance', 'ro.priya');
    await http().post('/api/credit-requests').set(auth(ro)).send({ borrowerName: 'Nashik Agro', borrowerRef: 'B-90', requestType: 'new',
      requestedAmount: '200000', currencyCode: 'INR' }).expect(422);
    const ok = await http().post('/api/credit-requests').set(auth(ro)).send({ borrowerName: 'Nashik Agro', borrowerRef: 'B-90', requestType: 'new',
      requestedAmount: '200000', currencyCode: 'INR', fields: { 'x.msme_udyam_number': 'UDYAM-MH-00-0000000' } }).expect(201);
    expect(ok.body.request.fields['x.msme_udyam_number']).toBe('UDYAM-MH-00-0000000');
    expect(ok.body.request.requestNumber).toMatch(/^LA\/\d{4}\/\d{6}$/); // padding changed by configuration above
  });

  it('validates workflow definitions before accepting them', async () => {
    const admin = await login('abc-finance', 'admin.anita');
    const res = await http().put('/api/workflows/new').set(auth(admin)).send({ definition: { initial: 'draft', states: [{ code: 'draft', label: 'Draft' }],
      transitions: [{ action: 'go', label: 'Go', from: 'draft', to: 'S', roles: ['relationship_officer'] }] } }).expect(422);
    expect(res.body.error).toBe('invalid_workflow');
  });
});

describe('audit trail', () => {
  it('records every change in an unbroken hash chain', async () => {
    const auditor = await login('xyz-bank', 'auditor.hana');
    const v = (await http().get('/api/audit/verify').set(auth(auditor)).expect(200)).body;
    expect(v.valid).toBe(true);
    expect(v.checked).toBeGreaterThan(5);
    const list = (await http().get('/api/audit?limit=50').set(auth(auditor)).expect(200)).body;
    expect(list.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['credit_request_created', 'credit_request_approve',
      'config_change_submitted', 'config_change_approved', 'tenant_provisioned']));
  });

  it('detects tampering with a stored record', async () => {
    const tenant = await ds.getRepository(Tenant).findOneByOrFail({ code: 'abc-finance' });
    const victim = await ds.getRepository(AuditEvent).findOneOrFail({ where: { tenantId: tenant.id, seq: 2 } });
    await ds.getRepository(AuditEvent).update({ id: victim.id, tenantId: tenant.id }, { afterData: '{"tampered":true}' });
    const auditor = await login('abc-finance', 'auditor.deepa');
    const v = (await http().get('/api/audit/verify').set(auth(auditor)).expect(200)).body;
    expect(v.valid).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
    expect(v.reason).toBe('record content altered');
  });
});
