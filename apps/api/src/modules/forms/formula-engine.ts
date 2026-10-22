/**
 * Formula engine for calculated fields (SDD Sections 18, 26.1).
 *
 * Pure and deterministic: no I/O, no clock, no floating point. Expressions are JSON documents stored as
 * configuration (core formulas, optionally overridden per tenant through governance). Every value is
 * exact decimal text; results are quantized with the tenant's configured rounding mode.
 *
 * Expression language (one operator per object):
 *   {"f": key}                 field value — same row for a grid formula, otherwise the record
 *   {"prev": key}              value of the field in the previous row of the same grid (financial periods)
 *   {"cfg": paramKey}          tenant decimal parameter
 *   {"n": "1.5"}               decimal literal (text)
 *   {"add": [..]}              sum; empty operands count as zero, all empty -> empty
 *   {"sub": [a, b]} {"mul": [..]} {"div": [a, b]}   any empty operand -> empty; division by zero -> empty
 *   {"pct": [a, b]}            a ÷ b × 100
 *   {"growth": [cur, prev]}    (cur − prev) ÷ |prev| × 100; empty when prev is empty or zero
 *   {"round": [x, places]}     round to whole places with the tenant rounding mode
 *   {"sum": {"grid": g, "of": x}}  sum of x over the rows of grid g (record formulas)
 *   {"fx_base": [amount, currency]} amount converted to the tenant base currency at the configured rate
 *   {"row_no": true}           1-based position of the row
 */
import Decimal from 'decimal.js';
import { dec, Dec, isDecimalText, roundingMode, toText } from '../../common/decimal';
import { DomainError } from '../../common/errors';

export type Expr = { [op: string]: unknown };
export type Value = string | boolean | null;
export interface GridRow { rowKey: string; values: Record<string, Value> }
export interface FormData { record: Record<string, Value>; grids: Record<string, GridRow[]> }
export interface FormulaDef { field: string; expression: Expr }

export interface FormulaContext {
  /** Tenant decimal parameter (throws if not configured). */
  cfg(key: string): string;
  /** Amount in base currency, or null when no rate is configured for the currency. */
  toBase(amount: string, currencyCode: string): string | null;
  /** Number of decimal places stored for the field. */
  scale(field: string): number;
  roundingMode: string;
}

/** Where a field lives: null = record level, otherwise the grid code. */
export type ScopeOf = (field: string) => string | null | undefined;

export class FormulaError extends DomainError {
  constructor(message: string) { super('invalid_formula', message); }
}

// guardrail-allow: percentage representation (x × 100), a unit conversion — not a business threshold
const HUNDRED = '100';
const OPS = new Set(['f', 'prev', 'cfg', 'n', 'add', 'sub', 'mul', 'div', 'pct', 'growth', 'round', 'sum', 'fx_base', 'row_no']);

function opOf(e: unknown): [string, unknown] {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new FormulaError(`Expected an operator object, got ${JSON.stringify(e)}`);
  const keys = Object.keys(e);
  if (keys.length !== 1 || !OPS.has(keys[0])) throw new FormulaError(`Unknown or ambiguous operator ${JSON.stringify(keys)}`);
  return [keys[0], (e as Expr)[keys[0]]];
}

function args(op: string, a: unknown, min: number, max = Infinity): unknown[] {
  if (!Array.isArray(a) || a.length < min || a.length > max) throw new FormulaError(`"${op}" needs ${min === max ? min : `${min}+`} operands`);
  return a;
}

interface Analysis { deps: Set<string>; cfg: Set<string> }

/** Validate an expression for a field in the given scope; collect the fields and parameters it reads. */
export function analyse(expr: unknown, scope: string | null, scopeOf: ScopeOf, out: Analysis = { deps: new Set(), cfg: new Set() }): Analysis {
  const [op, a] = opOf(expr);
  const field = (k: unknown, where: string | null, allowPrev: boolean) => {
    if (typeof k !== 'string') throw new FormulaError(`"${op}" needs a field key`);
    const s = scopeOf(k);
    if (s === undefined) throw new FormulaError(`Unknown field "${k}"`);
    if (op === 'prev' && !allowPrev) throw new FormulaError('"prev" is only valid in a grid formula');
    if (s !== null && s !== where) throw new FormulaError(`"${k}" is in grid "${s}"; use "sum" to read it from ${where ? `grid "${where}"` : 'a record formula'}`);
    out.deps.add(k);
  };
  switch (op) {
    case 'f': field(a, scope, false); break;
    case 'prev': if (scope === null) throw new FormulaError('"prev" is only valid in a grid formula'); field(a, scope, true); break;
    case 'cfg': if (typeof a !== 'string') throw new FormulaError('"cfg" needs a parameter key'); out.cfg.add(a); break;
    case 'n': if (!isDecimalText(a)) throw new FormulaError('"n" needs a decimal literal written as text'); break;
    case 'row_no': if (scope === null) throw new FormulaError('"row_no" is only valid in a grid formula'); break;
    case 'add': case 'mul': args(op, a, 1).forEach(x => analyse(x, scope, scopeOf, out)); break;
    case 'sub': case 'div': case 'pct': case 'growth': case 'fx_base': args(op, a, 2, 2).forEach(x => analyse(x, scope, scopeOf, out)); break;
    case 'round': {
      const [x, places] = args(op, a, 2, 2);
      if (!Number.isInteger(places) || (places as number) < 0) throw new FormulaError('"round" needs a whole number of places');
      analyse(x, scope, scopeOf, out); break;
    }
    case 'sum': {
      const s = a as { grid?: unknown; of?: unknown };
      if (!s || typeof s.grid !== 'string') throw new FormulaError('"sum" needs {"grid", "of"}');
      if (scope !== null) throw new FormulaError('"sum" is only valid in a record formula');
      analyse(s.of, s.grid, scopeOf, out); break;
    }
  }
  return out;
}

export interface CompiledFormula extends FormulaDef { scope: string | null; deps: Set<string>; cfg: Set<string> }

/** Validate all formulas and order them so every formula runs after the formulas it reads. */
export function compile(defs: FormulaDef[], scopeOf: ScopeOf): CompiledFormula[] {
  const byField = new Map<string, CompiledFormula>();
  for (const d of defs) {
    const scope = scopeOf(d.field);
    if (scope === undefined) throw new FormulaError(`Formula target "${d.field}" is not on the form`);
    if (byField.has(d.field)) throw new FormulaError(`Two formulas for "${d.field}"`);
    const { deps, cfg } = analyse(d.expression, scope, scopeOf);
    byField.set(d.field, { ...d, scope, deps, cfg });
  }
  const ordered: CompiledFormula[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: CompiledFormula, path: string[]) => {
    const s = state.get(f.field);
    if (s === 'done') return;
    if (s === 'visiting') throw new FormulaError(`Circular formula: ${[...path, f.field].join(' → ')}`);
    state.set(f.field, 'visiting');
    for (const d of f.deps) { const g = byField.get(d); if (g) visit(g, [...path, f.field]); }
    state.set(f.field, 'done');
    ordered.push(f);
  };
  for (const f of byField.values()) visit(f, []);
  return ordered;
}

type V = Dec | string | boolean | null;

interface Row { grid: string; index: number; rows: GridRow[] }

function num(v: V): Dec | null {
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'string') return isDecimalText(v) ? dec(v) : null;
  return v;
}

function evalExpr(expr: unknown, data: FormData, row: Row | null, ctx: FormulaContext): V {
  const [op, a] = opOf(expr);
  const many = () => (a as unknown[]).map(x => evalExpr(x, data, row, ctx));
  const nums = () => many().map(num);
  switch (op) {
    case 'f': return (row ? (row.rows[row.index].values[a as string] ?? data.record[a as string]) : data.record[a as string]) ?? null;
    case 'prev': return row && row.index > 0 ? row.rows[row.index - 1].values[a as string] ?? null : null;
    case 'cfg': return dec(ctx.cfg(a as string));
    case 'n': return dec(a as string);
    case 'row_no': return dec(String((row as Row).index + 1));
    case 'add': {
      const xs = nums();
      return xs.every(x => x === null) ? null : xs.reduce<Dec>((s, x) => (x ? s.plus(x) : s), dec('0'));
    }
    case 'sub': { const [x, y] = nums(); return x && y ? x.minus(y) : null; }
    case 'mul': { const xs = nums(); return xs.some(x => x === null) ? null : xs.reduce<Dec>((s, x) => s.times(x as Dec), dec('1')); }
    case 'div': { const [x, y] = nums(); return x && y && !y.isZero() ? x.dividedBy(y) : null; }
    case 'pct': { const [x, y] = nums(); return x && y && !y.isZero() ? x.dividedBy(y).times(HUNDRED) : null; }
    case 'growth': { const [x, y] = nums(); return x && y && !y.isZero() ? x.minus(y).dividedBy(y.abs()).times(HUNDRED) : null; }
    case 'round': {
      const [x, places] = a as [unknown, number];
      const v = num(evalExpr(x, data, row, ctx));
      return v ? v.toDecimalPlaces(places, roundingMode(ctx.roundingMode) as Decimal.Rounding) : null;
    }
    case 'sum': {
      const s = a as { grid: string; of: unknown };
      const rows = data.grids[s.grid] ?? [];
      const xs = rows.map((_, index) => num(evalExpr(s.of, data, { grid: s.grid, index, rows }, ctx)));
      return xs.every(x => x === null) ? null : xs.reduce<Dec>((t, x) => (x ? t.plus(x) : t), dec('0'));
    }
    case 'fx_base': {
      const [amt, ccy] = many();
      const x = num(amt);
      if (!x || typeof ccy !== 'string' || !ccy) return null;
      const base = ctx.toBase(toText(x), ccy);
      return base === null ? null : dec(base);
    }
  }
  return null;
}

function finish(v: V, field: string, ctx: FormulaContext): Value {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  return toText(v.toDecimalPlaces(ctx.scale(field), roundingMode(ctx.roundingMode) as Decimal.Rounding));
}

/**
 * Apply the compiled formulas to the data and return a copy with every calculated field (re)computed.
 * A formula that cannot be evaluated (missing inputs, no FX rate, division by zero) yields an empty value.
 */
export function evaluate(formulas: CompiledFormula[], input: FormData, ctx: FormulaContext): FormData {
  const data: FormData = {
    record: { ...input.record },
    grids: Object.fromEntries(Object.entries(input.grids).map(([g, rows]) => [g, rows.map(r => ({ rowKey: r.rowKey, values: { ...r.values } }))])),
  };
  for (const f of formulas) {
    if (f.scope === null) {
      data.record[f.field] = finish(evalExpr(f.expression, data, null, ctx), f.field, ctx);
    } else {
      const rows = data.grids[f.scope] ?? [];
      rows.forEach((r, index) => { r.values[f.field] = finish(evalExpr(f.expression, data, { grid: f.scope as string, index, rows }, ctx), f.field, ctx); });
    }
  }
  return data;
}
