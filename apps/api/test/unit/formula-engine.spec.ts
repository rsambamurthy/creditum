import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, evaluate, FormData, FormulaContext, FormulaDef } from '../../src/modules/forms/formula-engine';
import { multiply, toText } from '../../src/common/decimal';
import { LayoutDocument, placements } from '../../src/modules/forms/layout';

const scopes: Record<string, string | null> = { a: null, b: null, total: null, ratio: null, days: null, label: null, ccy: null,
  amt: 'lines', lineCcy: 'lines', share: 'lines', n: 'lines', rev: 'periods', growth: 'periods' };
const scopeOf = (k: string) => scopes[k];
const ctx = (over: Partial<FormulaContext> = {}): FormulaContext => ({
  cfg: k => ({ 'calculation.days_in_year': '365' } as Record<string, string>)[k] ?? (() => { throw new Error(`no ${k}`); })(),
  toBase: (amount, ccy) => (ccy === 'BBB' ? amount : ccy === 'USD' ? toText(multiply(amount, '0.307')) : null),
  scale: k => (k === 'days' ? 0 : 8), roundingMode: 'half_up', ...over,
});
const empty: FormData = { record: {}, grids: {} };
const run = (defs: FormulaDef[], data: FormData = empty, c = ctx()) => evaluate(compile(defs, scopeOf), data, c);

describe('formula engine', () => {
  it('is exact and quantizes with the configured rounding mode', () => {
    const r = run([{ field: 'ratio', expression: { div: [{ f: 'a' }, { f: 'b' }] } }], { record: { a: '1', b: '3' }, grids: {} });
    expect(r.record.ratio).toBe('0.33333333');
    const s = run([{ field: 'total', expression: { add: [{ f: 'a' }, { f: 'b' }] } }], { record: { a: '0.1', b: '0.2' }, grids: {} });
    expect(s.record.total).toBe('0.3');
    const big = run([{ field: 'total', expression: { add: [{ f: 'a' }, { f: 'b' }] } }], { record: { a: '12345678901234567890.12345678', b: '0.00000001' }, grids: {} });
    expect(big.record.total).toBe('12345678901234567890.12345679');
  });

  it('propagates empty values instead of guessing', () => {
    const r = run([
      { field: 'ratio', expression: { div: [{ f: 'a' }, { f: 'b' }] } },
      { field: 'total', expression: { add: [{ f: 'a' }, { f: 'b' }] } },
    ], { record: { a: '10', b: '0' }, grids: {} });
    expect(r.record.ratio).toBeNull(); // division by zero
    expect(r.record.total).toBe('10');
    const none = run([{ field: 'total', expression: { add: [{ f: 'a' }, { f: 'b' }] } }]);
    expect(none.record.total).toBeNull();
    const sub = run([{ field: 'total', expression: { sub: [{ f: 'a' }, { f: 'b' }] } }], { record: { a: '5' }, grids: {} });
    expect(sub.record.total).toBeNull();
  });

  it('orders formulas by dependency and evaluates grids before record totals', () => {
    const defs: FormulaDef[] = [
      { field: 'ratio', expression: { div: [{ f: 'total' }, { f: 'a' }] } },
      { field: 'share', expression: { pct: [{ fx_base: [{ f: 'amt' }, { f: 'lineCcy' }] }, { f: 'total' }] } },
      { field: 'total', expression: { sum: { grid: 'lines', of: { fx_base: [{ f: 'amt' }, { f: 'lineCcy' }] } } } },
      { field: 'n', expression: { row_no: true } },
    ];
    const r = run(defs, { record: { a: '2' }, grids: { lines: [
      { rowKey: 'r1', values: { amt: '1000', lineCcy: 'USD' } },
      { rowKey: 'r2', values: { amt: '693', lineCcy: 'BBB' } },
      { rowKey: 'r3', values: { amt: '50', lineCcy: 'ZZZ' } }, // no rate configured -> excluded, not guessed
    ] } });
    expect(r.record.total).toBe('1000');
    expect(r.record.ratio).toBe('500');
    expect(r.grids.lines.map(l => l.values.share)).toEqual(['30.7', '69.3', null]);
    expect(r.grids.lines.map(l => l.values.n)).toEqual(['1', '2', '3']);
  });

  it('computes period-on-period growth and rounds days with tenant parameters', () => {
    const r = run([
      { field: 'growth', expression: { growth: [{ f: 'rev' }, { prev: 'rev' }] } },
      { field: 'days', expression: { round: [{ mul: [{ div: [{ f: 'a' }, { f: 'b' }] }, { cfg: 'calculation.days_in_year' }] }, 0] } },
    ], { record: { a: '100', b: '1000' }, grids: { periods: [
      { rowKey: 'y1', values: { rev: '-200' } }, { rowKey: 'y2', values: { rev: '100' } }, { rowKey: 'y3', values: { rev: '150' } },
    ] } });
    expect(r.grids.periods.map(p => p.values.growth)).toEqual([null, '150', '50']);
    expect(r.record.days).toBe('37'); // 36.5 rounded half-up
    const even = run([{ field: 'days', expression: { round: [{ n: '36.5' }, 0] } }], empty, ctx({ roundingMode: 'half_even' }));
    expect(even.record.days).toBe('36');
  });

  it('does not change its input', () => {
    const input: FormData = { record: { a: '1', b: '2' }, grids: { lines: [{ rowKey: 'r', values: { amt: '1', lineCcy: 'BBB' } }] } };
    const snapshot = JSON.stringify(input);
    run([{ field: 'total', expression: { sum: { grid: 'lines', of: { f: 'amt' } } } }], input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('rejects invalid formulas at configuration time', () => {
    expect(() => compile([{ field: 'a', expression: { pow: [1, 2] } }], scopeOf)).toThrow(/Unknown/);
    expect(() => compile([{ field: 'a', expression: { f: 'nope' } }], scopeOf)).toThrow(/Unknown field/);
    expect(() => compile([{ field: 'a', expression: { f: 'amt' } }], scopeOf)).toThrow(/use "sum"/);
    expect(() => compile([{ field: 'a', expression: { prev: 'b' } }], scopeOf)).toThrow(/grid formula/);
    expect(() => compile([{ field: 'a', expression: { n: 0.1 } }], scopeOf)).toThrow(/decimal literal/);
    expect(() => compile([{ field: 'nope', expression: { n: '1' } }], scopeOf)).toThrow(/not on the form/);
    expect(() => compile([
      { field: 'a', expression: { add: [{ f: 'b' }] } }, { field: 'b', expression: { add: [{ f: 'total' }] } }, { field: 'total', expression: { f: 'a' } },
    ], scopeOf)).toThrow(/Circular formula: a → b → total → a/);
  });
});

describe('shipped core layout and formulas', () => {
  const seed = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'seed', f), 'utf8'));
  const layout = seed('core-layout.json') as LayoutDocument;
  const { formulas } = seed('core-formulas.json') as { formulas: { field: string; status: string; expression: FormulaDef['expression'] }[] };
  const placed = placements(layout);

  it('places every core library field exactly once', () => {
    const library = seed('creditum-core-field-library.v1.json') as { fields: { field_key: string; module: string }[] };
    const expected = library.fields.filter(f => !f.module.startsWith('Workspace')).map(f => f.field_key).sort();
    expect([...placed.keys()].sort()).toEqual(expected);
  });

  it('compiles every active core formula against the layout (valid references, no cycles)', () => {
    const active = formulas.filter(f => f.status === 'active');
    expect(active.length).toBeGreaterThan(50);
    const compiled = compile(active, k => (placed.has(k) ? placed.get(k)!.grid : undefined));
    expect(compiled).toHaveLength(active.length);
    expect(formulas.filter(f => f.status === 'pending').every(f => f.expression === null)).toBe(true);
  });
});

describe('formula text (low-code editing)', () => {
  const { parseFormula, formatFormula } = require('../../src/modules/forms/formula-text') as typeof import('../../src/modules/forms/formula-text');
  const labels: Record<string, string> = { a: 'Sales', b: 'Cost of Sales', total: 'Total', amt: 'Amount', lineCcy: 'Currency', rev: 'Revenue' };
  const names = {
    resolve: (ref: string) => { const k = Object.keys(labels).find(x => labels[x].toLowerCase() === ref.toLowerCase()); if (!k) throw new Error(`No field called [${ref}]`); return k; },
    name: (k: string) => labels[k],
  };
  const parse = (t: string) => parseFormula(t, names, k => scopes[k] ?? null);

  it('reads spreadsheet-style text, with ÷ × − and precedence', () => {
    expect(parse('[Sales] - [Cost of Sales]')).toEqual({ sub: [{ f: 'a' }, { f: 'b' }] });
    expect(parse('([Sales] − [Cost of Sales]) ÷ [Sales] × 100')).toEqual({ mul: [{ div: [{ sub: [{ f: 'a' }, { f: 'b' }] }, { f: 'a' }] }, { n: '100' }] });
    expect(parse('PERCENT([sales], [Total])')).toEqual({ pct: [{ f: 'a' }, { f: 'total' }] });
    expect(parse('ROUND([Sales] / [Total] * PARAM("calculation.days_in_year"), 0)'))
      .toEqual({ round: [{ mul: [{ div: [{ f: 'a' }, { f: 'total' }] }, { cfg: 'calculation.days_in_year' }] }, 0] });
    expect(parse('SUM(TO_BASE([Amount], [Currency]))')).toEqual({ sum: { grid: 'lines', of: { fx_base: [{ f: 'amt' }, { f: 'lineCcy' }] } } });
    expect(parse('GROWTH([Revenue], PREVIOUS([Revenue]))')).toEqual({ growth: [{ f: 'rev' }, { prev: 'rev' }] });
  });

  it('explains mistakes in plain words with the position', () => {
    expect(() => parse('[Sales] +')).toThrow(/ends too early/);
    expect(() => parse('[Salez] + 1')).toThrow(/No field called \[Salez\]/);
    expect(() => parse('AVERAGE([Sales])')).toThrow(/Unknown function AVERAGE/);
    expect(() => parse('[Sales] [Total]')).toThrow(/Unexpected "Total" \(at character 9\)/);
    expect(() => parse('ROUND([Sales], 1.5)')).toThrow(/whole number of places/);
  });

  it('writes every shipped core formula as text and reads it back unchanged', () => {
    const lib = JSON.parse(readFileSync(join(__dirname, '..', '..', 'seed', 'creditum-core-field-library.v1.json'), 'utf8')) as { fields: { field_key: string; label: string; group: string }[] };
    const layout = JSON.parse(readFileSync(join(__dirname, '..', '..', 'seed', 'core-layout.json'), 'utf8')) as LayoutDocument;
    const placed = placements(layout);
    const byKey = new Map(lib.fields.map(f => [f.field_key, f]));
    const qualified = { resolve: (ref: string) => { const [g, l] = ref.split(' › '); return lib.fields.find(f => f.group === g && f.label === l)!.field_key; },
      name: (k: string) => `${byKey.get(k)!.group} › ${byKey.get(k)!.label}` };
    const { formulas } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'seed', 'core-formulas.json'), 'utf8')) as { formulas: { status: string; expression: unknown }[] };
    for (const f of formulas.filter(x => x.status === 'active')) {
      const text = formatFormula(f.expression, qualified);
      expect(parseFormula(text, qualified, k => placed.get(k)?.grid ?? null)).toEqual(f.expression);
    }
  });
});
