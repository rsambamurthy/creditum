'use strict';
/**
 * Core banking simulator — build and test only, fictional data only.
 *
 * Implements the Creditum core banking connector contract (docs/integrations/core-banking-connector.md):
 *   GET  /health
 *   GET  /v1/institutions/:institution/customers?q=&limit=               search by customer number or name (list of values)
 *   GET  /v1/institutions/:institution/customers/:cif                    customer master, group, partners
 *   GET  /v1/institutions/:institution/customers/:cif/facilities         existing credit facilities
 *   GET  /v1/institutions/:institution/customers/:cif/security-packages  packages with their facilities and collateral
 *   GET  /v1/institutions/:institution/customers/:cif/guarantees
 *   GET  /v1/institutions/:institution/customers/:cif/collateral         collateral not in a package
 *   POST /v1/institutions/:institution/bookings/limits                   book approved limits -> references
 *   POST /v1/institutions/:institution/bookings/collateral               book collateral -> collateral numbers
 *
 * Every /v1 call needs the header x-api-key. Booking references are derived from the request number and line,
 * so a repeated booking returns the same references (idempotent) and the service keeps no state.
 * No dependencies beyond Node.js.
 */
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const DATA_DIR = join(__dirname, '..', 'data');
const MAX_BODY_BYTES = 64 * 1024; // guardrail-allow: request size limit of the simulator, not a business value
const SEARCH_LIMIT = { default: 20, max: 50 };

function searchCustomers(inst, q, limit) {
  const needle = q.trim().toLowerCase();
  const all = Object.values(inst.customers).map(c => c.customer)
    .filter(c => !needle || c.cif.toLowerCase().includes(needle) || (c.name ?? '').toLowerCase().includes(needle))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const n = Math.min(Math.max(Number.isInteger(limit) && limit > 0 ? limit : SEARCH_LIMIT.default, 1), SEARCH_LIMIT.max);
  return { total: all.length, items: all.slice(0, n).map(c => ({ cif: c.cif, name: c.name, segment: c.segment, newOrExisting: c.newOrExisting, idType: c.idType, idNumber: c.idNumber })) };
}

function loadInstitutions(dir = DATA_DIR) {
  const out = new Map();
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    out.set(doc.institution, doc);
  }
  return out;
}

function reference(prefix, ...parts) {
  const h = createHash('sha256').update([prefix, ...parts].join('|')).digest('hex').toUpperCase();
  return `${prefix}${h.slice(0, 10)}`;
}

function digitsFrom(...parts) {
  const h = createHash('sha256').update(parts.join('|')).digest();
  return Array.from(h, b => String(b % 10)).join('');
}

function sameKey(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function bookLimits(inst, body) {
  if (!body || typeof body.cif !== 'string' || typeof body.creditRequestNumber !== 'string' || !Array.isArray(body.lines) || body.lines.length === 0) {
    return [422, { error: 'invalid_booking', message: 'cif, creditRequestNumber and at least one line are required' }];
  }
  const customer = inst.customers[body.cif];
  if (!customer) return [404, { error: 'customer_not_found', message: `No customer ${body.cif}` }];
  const bookedOn = new Date().toISOString().slice(0, 10);
  const lines = [];
  for (const l of body.lines) {
    if (!l || typeof l.lineRef !== 'string' || typeof l.amount !== 'string' || typeof l.currency !== 'string') {
      return [422, { error: 'invalid_booking', message: 'each line needs lineRef, amount (decimal text) and currency' }];
    }
    const existing = l.facilityId ? (customer.facilities ?? []).find(f => f.facilityId === l.facilityId) : null;
    if (l.facilityId && !existing) return [422, { error: 'unknown_facility', message: `Facility ${l.facilityId} does not belong to ${body.cif}` }];
    const key = [inst.institution, body.creditRequestNumber, l.lineRef];
    lines.push({
      lineRef: l.lineRef,
      limitReference: existing ? existing.facilityId : reference(inst.booking.limitPrefix, ...key),
      limitType: existing ? existing.type : (l.limitType ?? inst.booking.defaultLimitType),
      accountNumber: existing ? existing.settlementAccount : `${inst.booking.accountPrefix}${digitsFrom(...key).slice(0, inst.booking.accountDigits)}`,
      contractReference: reference(inst.booking.contractPrefix, ...key),
      contractDate: bookedOn,
      maturityDate: l.maturityDate ?? (existing ? existing.maturity : null),
    });
  }
  return [200, { bookedAt: new Date().toISOString(), creditRequestNumber: body.creditRequestNumber, lines }];
}

function bookCollateral(inst, body) {
  if (!body || typeof body.cif !== 'string' || typeof body.creditRequestNumber !== 'string' || !Array.isArray(body.items) || body.items.length === 0) {
    return [422, { error: 'invalid_booking', message: 'cif, creditRequestNumber and at least one item are required' }];
  }
  if (!inst.customers[body.cif]) return [404, { error: 'customer_not_found', message: `No customer ${body.cif}` }];
  const items = [];
  for (const it of body.items) {
    if (!it || typeof it.itemRef !== 'string') return [422, { error: 'invalid_booking', message: 'each item needs itemRef' }];
    items.push({ itemRef: it.itemRef, collateralNo: reference(inst.booking.collateralPrefix, inst.institution, body.creditRequestNumber, it.itemRef) });
  }
  return [200, { bookedAt: new Date().toISOString(), creditRequestNumber: body.creditRequestNumber, items }];
}

function createSimulator({ apiKey, institutions = loadInstitutions(), log = () => {} }) {
  if (!apiKey || apiKey.length < 24) throw new Error('The simulator needs an API key of at least 24 characters (SIM_API_KEY)');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://simulator');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', institutions: [...institutions.keys()] });
      if (parts[0] !== 'v1' || parts[1] !== 'institutions' || parts.length < 4) return send(res, 404, { error: 'not_found' });
      if (!sameKey(req.headers['x-api-key'], apiKey)) return send(res, 401, { error: 'unauthorized', message: 'A valid x-api-key header is required' });
      const inst = institutions.get(parts[2]);
      if (!inst) return send(res, 404, { error: 'institution_not_found', message: `No institution ${parts[2]}` });
      log(`${req.method} ${url.pathname}`);
      if (req.method === 'GET' && parts[3] === 'customers' && parts.length === 4) {
        return send(res, 200, searchCustomers(inst, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit'))));
      }
      if (req.method === 'GET' && parts[3] === 'customers' && parts[4]) {
        const c = inst.customers[parts[4]];
        if (!c) return send(res, 404, { error: 'customer_not_found', message: `No customer ${parts[4]}` });
        const sub = parts[5];
        if (!sub) return send(res, 200, c.customer);
        const lists = { facilities: c.facilities, 'security-packages': c.securityPackages, guarantees: c.guarantees, collateral: c.collateral };
        if (!(sub in lists) || parts.length > 6) return send(res, 404, { error: 'not_found' });
        return send(res, 200, lists[sub] ?? []);
      }
      if (req.method === 'POST' && parts[3] === 'bookings' && parts.length === 5) {
        const body = await readJson(req);
        const [status, out] = parts[4] === 'limits' ? bookLimits(inst, body) : parts[4] === 'collateral' ? bookCollateral(inst, body) : [404, { error: 'not_found' }];
        return send(res, status, out);
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      return send(res, e.status ?? 500, { error: e.status ? 'bad_request' : 'internal_error', message: e.status ? e.message : 'Unexpected error' });
    }
  });
}

module.exports = { createSimulator, loadInstitutions };

if (require.main === module) {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be set');
  const server = createSimulator({ apiKey: process.env.SIM_API_KEY, log: m => console.log(new Date().toISOString(), m) });
  const ready = () => console.log(`Core banking simulator listening on ${port} (institutions: ${[...loadInstitutions().keys()].join(', ')})`);
  // IPv6 and IPv4 where the host supports it (Railway private networking is IPv6); IPv4 only otherwise.
  server.once('error', e => { if (e.code === 'EAFNOSUPPORT') server.listen(port, '0.0.0.0', ready); else throw e; });
  server.listen(port, '::', ready);
}
