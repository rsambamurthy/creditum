/**
 * Rules Engine evaluator (SDD Section 19.2) — a small, side-effect-free interpreter for
 * condition -> action rules stored as data.
 *
 * Condition language (JSON-Logic style):
 *   {"var": "requested_amount"}         value of a field on the record
 *   {"cfg": "credit.narrative_above"}   value of a tenant configuration parameter
 *   {"and": [..]} {"or": [..]} {"not": x}
 *   {"==":[a,b]} {"!=":[a,b]} {">":[a,b]} {">=":[a,b]} {"<":[a,b]} {"<=":[a,b]}
 *   {"in": [a, [x, y]]}  {"empty": a}
 * Numeric comparisons use exact decimal arithmetic. Thresholds belong in configuration ({"cfg": ...}),
 * which is how the same rule logic carries different limits for different tenants.
 *
 * Actions: {"type":"block","message":"..."} | {"type":"warn","message":"..."} |
 *          {"type":"require","field":"<field_key>","message":"..."} | {"type":"hide","field":"<field_key>"}
 */
import { compare, isDecimalText } from '../../common/decimal';
import { DomainError } from '../../common/errors';

export type Condition = unknown;
export interface RuleAction { type: 'block' | 'warn' | 'require' | 'hide'; field?: string; message?: string }
export interface Rule { ruleKey: string; name: string; condition: Condition; actions: RuleAction[] }
export interface Outcome {
  blocks: { rule: string; message: string }[];
  warnings: { rule: string; message: string }[];
  required: { rule: string; field: string; message: string }[];
  hidden: string[];
  fired: string[];
}

type Lookup = (key: string) => unknown;
const OPS = new Set(['var', 'cfg', 'and', 'or', 'not', '==', '!=', '>', '>=', '<', '<=', 'in', 'empty']);

function isEmpty(v: unknown) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

function numericPair(a: unknown, b: unknown): [string, string] | null {
  const toDec = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : isDecimalText(v) ? (v as string) : null);
  const x = toDec(a); const y = toDec(b);
  return x !== null && y !== null ? [x, y] : null;
}

function cmp(a: unknown, b: unknown): number | null {
  const n = numericPair(a, b);
  if (n) return compare(n[0], n[1]);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

export function evaluateCondition(cond: Condition, record: Lookup, cfg: Lookup): unknown {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return cond;
  const keys = Object.keys(cond);
  if (keys.length !== 1 || !OPS.has(keys[0])) throw new DomainError('invalid_rule', `Unknown rule operator: ${JSON.stringify(keys)}`);
  const op = keys[0];
  const arg = (cond as Record<string, unknown>)[op];
  const ev = (c: Condition) => evaluateCondition(c, record, cfg);
  const pair = (): [unknown, unknown] => {
    // guardrail-allow: operator arity (binary operators take two operands), not a business threshold
    if (!Array.isArray(arg) || arg.length !== 2) throw new DomainError('invalid_rule', `Operator "${op}" needs exactly two operands`);
    return [ev(arg[0]), ev(arg[1])];
  };
  switch (op) {
    case 'var': return record(String(arg));
    case 'cfg': return cfg(String(arg));
    case 'and': return (arg as Condition[]).every(c => Boolean(ev(c)));
    case 'or': return (arg as Condition[]).some(c => Boolean(ev(c)));
    case 'not': return !ev(arg);
    case 'empty': return isEmpty(ev(arg));
    case '==': { const [a, b] = pair(); const c = cmp(a, b); return c === null ? a === b : c === 0; }
    case '!=': { const [a, b] = pair(); const c = cmp(a, b); return c === null ? a !== b : c !== 0; }
    case '>': case '>=': case '<': case '<=': {
      const [a, b] = pair();
      if (isEmpty(a) || isEmpty(b)) return false;
      const c = cmp(a, b);
      if (c === null) throw new DomainError('invalid_rule', `Cannot compare ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
      return op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0;
    }
    case 'in': {
      const [a, list] = pair();
      if (!Array.isArray(list)) throw new DomainError('invalid_rule', '"in" needs a list as its second operand');
      return list.some(x => (cmp(a, x) ?? (a === x ? 0 : 1)) === 0);
    }
  }
  return undefined;
}

/** Validate a rule's shape before it is stored (dry-run against an empty record, without config). */
export function validateRule(rule: Rule): void {
  const walk = (c: Condition): void => {
    if (c === null || typeof c !== 'object') return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    const keys = Object.keys(c);
    if (keys.length !== 1 || !OPS.has(keys[0])) throw new DomainError('invalid_rule', `Unknown rule operator: ${JSON.stringify(keys)}`);
    walk((c as Record<string, unknown>)[keys[0]]);
  };
  walk(rule.condition);
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) throw new DomainError('invalid_rule', 'A rule needs at least one action');
  for (const a of rule.actions) {
    if (!['block', 'warn', 'require', 'hide'].includes(a.type)) throw new DomainError('invalid_rule', `Unknown action type "${a.type}"`);
    if ((a.type === 'require' || a.type === 'hide') && !a.field) throw new DomainError('invalid_rule', `Action "${a.type}" needs a field`);
    if ((a.type === 'block' || a.type === 'warn') && !a.message) throw new DomainError('invalid_rule', `Action "${a.type}" needs a message`);
  }
}

export function evaluateRules(rules: Rule[], record: Lookup, cfg: Lookup): Outcome {
  const out: Outcome = { blocks: [], warnings: [], required: [], hidden: [], fired: [] };
  for (const r of rules) {
    if (!evaluateCondition(r.condition, record, cfg)) continue;
    out.fired.push(r.ruleKey);
    for (const a of r.actions) {
      if (a.type === 'block') out.blocks.push({ rule: r.ruleKey, message: a.message! });
      if (a.type === 'warn') out.warnings.push({ rule: r.ruleKey, message: a.message! });
      if (a.type === 'require') out.required.push({ rule: r.ruleKey, field: a.field!, message: a.message ?? `${a.field} is required` });
      if (a.type === 'hide') out.hidden.push(a.field!);
    }
  }
  return out;
}
