#!/usr/bin/env node
/**
 * Creditum engineering guardrails (SDD Section 25.4).
 *
 * A change that violates any rule fails the build. Rules are checked on the TypeScript syntax tree,
 * not by text search, so comments and identifiers do not trigger them.
 *
 *   no-hardcoded-currency   ISO 4217 codes or currency symbols as literals in application code
 *   no-hardcoded-threshold  numeric thresholds in comparisons, decimal arithmetic or limit-like names
 *   no-float-money          money / rate / ratio properties typed as JavaScript number; parseFloat
 *   no-vendor-sql           raw SQL execution or engine-specific SQL in strings
 *   no-db-logic             stored procedures, triggers or database functions
 *   tenant-scope            reads/updates/deletes on repositories without tenant scoping
 *
 * Escape hatch: a comment "guardrail-allow: <reason>" on the same or the previous line. Every use is
 * listed in the report so reviewers see each exception and its reason.
 *
 * Usage: node check.mjs            check the repository
 *        node check.mjs --self-test prove every rule fires on tools/guardrails/fixtures
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ISO 4217 active codes (this list is tooling data, not application code).
const ISO4217 = new Set(`AED AFN AMD AOA ARS AUD AWG AZN BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CZK DJF DKK DOP
DZD EGP ERN ETB EUR FJD FKP GBP GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK
LBP LKR LRD LSL LYD MDL MGA MKD MMK MNT MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD
SCR SDG SEK SGD SHP SLE SRD SSP STN SVC SYP SZL THB TJS TMT TND TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL`.split(/\s+/));
const CURRENCY_SYMBOL = /[₹€£¥₩₦₱₪₫]|\$\s?\d|\bKD\s?\d|\bRs\.?\s?\d|\bSAR\s?\d|\bAED\s?\d/;
const COMPARISON = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const DECIMAL_CALLS = new Set(['gt', 'gte', 'lt', 'lte', 'comparedTo', 'times', 'mul', 'div', 'dividedBy', 'plus', 'minus', 'compare', 'multiply', 'quantize',
  'toDecimalPlaces', 'min', 'max']);
const LIMIT_NAME = /(limit|threshold|ceiling|maximum|minimum|max[A-Z_]|min[A-Z_]|rate|ratio|fee|tolerance|retention|amount|coverage|margin)/i;
const MONEY_NAME = /(amount|limit|value|rate|ratio|fee|balance|exposure|price|margin|coverage|outstanding|utili[sz]ation)/i;
const VENDOR_SQL = /\b(NVL|NVL2|ISNULL|GETDATE|SYSDATE|SYSTIMESTAMP|NOW|DATEADD|DATEDIFF|TO_CHAR|TO_DATE|STRING_AGG|LISTAGG|GROUP_CONCAT|JSON_VALUE|JSON_EXTRACT)\s*\(|\bILIKE\b|::[a-z]+\b|->>|\bROWNUM\b|\bLIMIT\s+\d|\bTOP\s*\(?\d|\bFETCH\s+FIRST\b/i;
const DB_LOGIC = /CREATE\s+(OR\s+REPLACE\s+|OR\s+ALTER\s+)?(PROCEDURE|PROC|TRIGGER|FUNCTION|PACKAGE)\b/i;
const TENANT_METHODS = new Set(['find', 'findOne', 'findOneOrFail', 'findBy', 'findOneBy', 'findOneByOrFail', 'findAndCount', 'count', 'countBy', 'update', 'delete', 'exists', 'existsBy', 'softDelete']);
const TENANT_OK = /tenantWhere|ownerScope|tenantId|visibleScopes/;
const TENANT_EXEMPT = /getRepository\((Tenant)\)/; // the tenants table itself is the tenant registry

const SCAN = [
  { dir: 'apps/api/src', ext: ['.ts'] },
  { dir: 'apps/web/src', ext: ['.ts', '.tsx'] },
];

function files(dir, exts) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== 'dist') out.push(...files(p, exts)); continue; }
    if (exts.some(x => p.endsWith(x)) && !/\.(spec|test)\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function checkFile(path, display) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isApiModule = display.split(sep).join('/').includes('apps/api/src/modules/') || display.includes('fixtures');
  const isMigration = display.includes('migrations');
  const findings = [];
  const allowed = [];
  const lineOf = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  const allowReason = line => {
    for (const l of [line, line - 1]) {
      const m = (lines[l] ?? '').match(/guardrail-allow:\s*(.+?)\s*(\*\/)?$/);
      if (m) return m[1];
    }
    return null;
  };
  const report = (node, rule, message) => {
    const line = lineOf(node);
    const reason = allowReason(line);
    const entry = { file: display, line: line + 1, rule, message };
    if (reason) allowed.push({ ...entry, reason }); else findings.push(entry);
  };

  const visit = node => {
    // ---- currency
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const v = node.text;
      if (ISO4217.has(v)) report(node, 'no-hardcoded-currency', `Currency code "${v}" is hardcoded — read it from tenant configuration`);
      else if (CURRENCY_SYMBOL.test(v)) report(node, 'no-hardcoded-currency', `Currency symbol or amount "${v.slice(0, 40)}" is hardcoded`);
      if (VENDOR_SQL.test(v)) report(node, 'no-vendor-sql', `Engine-specific SQL in "${v.slice(0, 60)}"`);
      if (DB_LOGIC.test(v)) report(node, 'no-db-logic', 'Stored procedures, triggers and database functions are not allowed — logic belongs in the rules/workflow engines');
      // decimal thresholds passed as text to decimal helpers
      if (isApiModule && /^-?\d+(\.\d+)?$/.test(v) && !['0', '1'].includes(v) && ts.isCallExpression(node.parent)) {
        const callee = node.parent.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (DECIMAL_CALLS.has(name) || name === 'dec') report(node, 'no-hardcoded-threshold', `Decimal threshold "${v}" is hardcoded — read it from configuration`);
      }
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map(s => s.literal.text)].join(' ');
      if (CURRENCY_SYMBOL.test(parts)) report(node, 'no-hardcoded-currency', 'Currency symbol is hardcoded in a template string');
    }
    // ---- thresholds
    if (isApiModule && ts.isNumericLiteral(node) && !['0', '1'].includes(node.text)) {
      const p = node.parent && ts.isPrefixUnaryExpression(node.parent) ? node.parent.parent : node.parent;
      if (p && ts.isBinaryExpression(p) && COMPARISON.has(p.operatorToken.kind)) {
        report(node, 'no-hardcoded-threshold', `Numeric threshold ${node.text} in a comparison — read it from configuration`);
      } else if (p && ts.isCallExpression(p)) {
        const callee = p.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (DECIMAL_CALLS.has(name)) report(node, 'no-hardcoded-threshold', `Numeric value ${node.text} passed to ${name}() — read it from configuration`);
      } else if (p && (ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name && LIMIT_NAME.test(p.name.getText(sf))) {
        report(node, 'no-hardcoded-threshold', `"${p.name.getText(sf)}" is set to the literal ${node.text} — read it from configuration`);
      }
    }
    // ---- float money
    if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) && node.type && node.name &&
        node.type.kind === ts.SyntaxKind.NumberKeyword && MONEY_NAME.test(node.name.getText(sf)) && !/version|units|rank|seconds|count|padding|next|seq|page|size/i.test(node.name.getText(sf))) {
      report(node, 'no-float-money', `"${node.name.getText(sf)}" is typed as number — use a decimal string`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      if (name === 'parseFloat') report(node, 'no-float-money', 'parseFloat converts to floating point — use the decimal helpers');
      // ---- raw SQL
      if (name === 'query' && node.arguments.length && (ts.isStringLiteral(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
        report(node, 'no-vendor-sql', 'Raw SQL execution — use the portable data-access layer');
      }
      // ---- tenant scope
      if (isApiModule && !isMigration && TENANT_METHODS.has(name) && ts.isPropertyAccessExpression(callee)) {
        const recv = callee.expression.getText(sf);
        const looksLikeRepo = /getRepository\(|repo\b|Repository|\.repo\(/.test(recv);
        const args = node.arguments.map(a => a.getText(sf)).join(' ');
        if (looksLikeRepo && !TENANT_EXEMPT.test(recv) && !TENANT_OK.test(args)) {
          report(node, 'tenant-scope', `${name}() on a repository without tenant scoping (use tenantWhere / visibleScopes)`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, allowed };
}

function run(paths) {
  const findings = []; const allowed = [];
  for (const p of paths) {
    const r = checkFile(p, relative(ROOT, p));
    findings.push(...r.findings); allowed.push(...r.allowed);
  }
  return { findings, allowed };
}

if (process.argv.includes('--self-test')) {
  const fx = files(join(HERE, 'fixtures'), ['.ts']);
  const { findings } = run(fx);
  const fired = new Set(findings.map(f => f.rule));
  const expected = ['no-hardcoded-currency', 'no-hardcoded-threshold', 'no-float-money', 'no-vendor-sql', 'no-db-logic', 'tenant-scope'];
  const missing = expected.filter(r => !fired.has(r));
  for (const f of findings) console.log(`  fixture ${f.file}:${f.line}  ${f.rule}`);
  if (missing.length) { console.error(`Guardrail self-test FAILED — rules that did not fire: ${missing.join(', ')}`); process.exit(1); }
  console.log(`Guardrail self-test passed — all ${expected.length} rules fire on the fixtures.`);
  process.exit(0);
}

const targets = SCAN.flatMap(s => files(join(ROOT, s.dir), s.ext));
const { findings, allowed } = run(targets);
console.log(`Creditum guardrails — ${targets.length} files checked.`);
if (allowed.length) {
  console.log(`\nAllowed exceptions (${allowed.length}) — each needs a reviewer's agreement:`);
  for (const a of allowed) console.log(`  ${a.file}:${a.line}  ${a.rule}  — ${a.reason}`);
}
if (findings.length) {
  console.error(`\n${findings.length} guardrail violation(s):`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.message}`);
  process.exit(1);
}
console.log('\nNo violations.');
