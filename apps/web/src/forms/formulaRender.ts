/**
 * Plain-language rendering of a formula expression (port of render() in tools/library/build_layout.py).
 * Field keys become their labels; operators become ÷ × + −. Never evaluates anything.
 */
import type { FormulaExpr } from '../api';

export interface RenderNames { field: (key: string) => string; grid: (code: string) => string }

export function renderFormula(e: unknown, n: RenderNames): string {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`Expected an operator object, got ${JSON.stringify(e)}`);
  const keys = Object.keys(e);
  if (keys.length !== 1) throw new Error(`One operator per object, got ${JSON.stringify(keys)}`);
  const op = keys[0];
  const a = (e as FormulaExpr)[op];
  const r = (x: unknown) => renderFormula(x, n);
  const list = (): unknown[] => { if (!Array.isArray(a)) throw new Error(`"${op}" needs a list of operands`); return a; };
  switch (op) {
    case 'f': return n.field(String(a));
    case 'prev': return `previous period ${n.field(String(a))}`;
    case 'cfg': return `parameter ${String(a)}`;
    case 'n': return String(a);
    case 'row_no': return 'row number';
    case 'add': return `(${list().map(r).join(' + ')})`;
    case 'mul': return list().map(r).join(' × ');
    case 'sub': { const [x, y] = list(); return `(${r(x)} − ${r(y)})`; }
    case 'div': { const [x, y] = list(); return `${r(x)} ÷ ${r(y)}`; }
    case 'pct': { const [x, y] = list(); return `${r(x)} ÷ ${r(y)} × 100`; }
    case 'growth': { const [x, y] = list(); return `(${r(x)} − ${r(y)}) ÷ |${r(y)}| × 100`; }
    case 'round': { const [x, places] = list(); return `round(${r(x)}, ${String(places)} places)`; }
    case 'sum': { const s = a as { grid?: string; of?: unknown }; return `Σ over ${n.grid(String(s?.grid))} rows of [${r(s?.of)}]`; }
    case 'fx_base': { const [x, c] = list(); return `${r(x)} in base currency (rate for ${r(c)})`; }
    default: throw new Error(`Unknown operator "${op}"`);
  }
}

/** Operator reference shown in the editor's syntax help (mirrors the formula engine's header comment). */
export const FORMULA_SYNTAX: [string, string][] = [
  ['{"f": key}', 'Field value — the same row for a grid formula, otherwise the request record'],
  ['{"prev": key}', 'The field in the previous row of the same grid (financial periods)'],
  ['{"cfg": parameter}', 'A decimal configuration parameter of the workspace'],
  ['{"n": "1.5"}', 'A number, written as text'],
  ['{"add": [a, b, …]}', 'Sum; empty items count as zero (all empty → empty)'],
  ['{"sub": [a, b]}', 'a − b (any empty operand → empty)'],
  ['{"mul": [a, b, …]}', 'Product (any empty operand → empty)'],
  ['{"div": [a, b]}', 'a ÷ b (division by zero → empty)'],
  ['{"pct": [a, b]}', 'a ÷ b × 100'],
  ['{"growth": [current, previous]}', '(current − previous) ÷ |previous| × 100'],
  ['{"round": [x, places]}', 'Round to whole places with the workspace rounding mode'],
  ['{"sum": {"grid": g, "of": x}}', 'Σ of x over the rows of grid g (record formulas)'],
  ['{"fx_base": [amount, currency]}', 'Amount converted to the base currency at the configured rate'],
  ['{"row_no": true}', '1-based position of the row'],
];
