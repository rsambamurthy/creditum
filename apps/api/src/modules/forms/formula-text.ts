/**
 * Spreadsheet-style text for formulas (low-code editing). Administrators type
 *
 *     PERCENT([Gross Profit], [Revenue / Sales])
 *     [Total Current Assets] / [Total Current Liabilities]
 *     ROUND([Accounts Receivable (Net)] / [Revenue / Sales] * PARAM("calculation.days_in_year"), 0)
 *
 * and the text is translated to the stored expression (formula-engine.ts) and back. Pure: field names are
 * resolved through the callbacks the caller passes in, so the same code serves every tenant's labels.
 *
 * Grammar
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*            (× ÷ − are accepted too)
 *   unary   := '-' unary | primary
 *   primary := number | [Field] | [Section › Field] | NAME '(' args ')' | '(' expr ')'
 *   NAME    := PREVIOUS | SUM | GROWTH | PERCENT | TO_BASE | ROUND | PARAM | ROW_NUMBER
 */
import { Expr } from './formula-engine';
import { FormulaError } from './formula-engine';

export interface FieldResolver {
  /** Field key for a reference as typed ("Gross Profit" or "Income Statement › Net Profit"); throws a FormulaError if unknown/ambiguous. */
  resolve(ref: string): string;
}
export interface FieldNamer {
  /** Shortest unambiguous reference for a key ("Gross Profit" or "Section › Label"). */
  name(key: string): string;
}

type Tok = { t: 'num' | 'ref' | 'str' | 'name' | 'op' | '(' | ')' | ','; v: string; at: number };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const err = (msg: string, at = i): never => { throw new FormulaError(`${msg} (at character ${at + 1})`); };
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^\d+(\.\d+)?|^\.\d+/.exec(text.slice(i));
      if (!m) err('Malformed number');
      out.push({ t: 'num', v: m![0].startsWith('.') ? `0${m![0]}` : m![0], at: i }); i += m![0].length; continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', i);
      if (end < 0) err('Missing "]" after a field name');
      const ref = text.slice(i + 1, end).trim();
      if (!ref) err('Empty field name "[]"');
      out.push({ t: 'ref', v: ref, at: i }); i = end + 1; continue;
    }
    if (ch === '"' || ch === '“' || ch === '”') {
      const close = text.slice(i + 1).search(/["“”]/);
      if (close < 0) err('Missing closing quote');
      out.push({ t: 'str', v: text.slice(i + 1, i + 1 + close), at: i }); i += close + 2; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))!;
      out.push({ t: 'name', v: m[0].toUpperCase(), at: i }); i += m[0].length; continue;
    }
    const op = ({ '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '/': '/', '÷': '/' } as Record<string, string>)[ch];
    if (op) { out.push({ t: 'op', v: op, at: i }); i += 1; continue; }
    if (ch === '(' || ch === ')' || ch === ',') { out.push({ t: ch, v: ch, at: i }); i += 1; continue; }
    err(`Unexpected "${ch}"`);
  }
  return out;
}

const FUNCTIONS: Record<string, { min: number; max: number; hint: string }> = {
  PREVIOUS: { min: 1, max: 1, hint: 'PREVIOUS([Field]) — the value in the previous period' },
  SUM: { min: 1, max: 1, hint: 'SUM(expression) — total over the rows of a table' },
  GROWTH: { min: 2, max: 2, hint: 'GROWTH(current, previous) — % change' },
  PERCENT: { min: 2, max: 2, hint: 'PERCENT(part, whole) — part ÷ whole × 100' },
  TO_BASE: { min: 2, max: 2, hint: 'TO_BASE(amount, [Currency field]) — converted to the base currency' },
  ROUND: { min: 2, max: 2, hint: 'ROUND(value, places)' },
  PARAM: { min: 1, max: 1, hint: 'PARAM("parameter.key") — a numeric tenant setting' },
  ROW_NUMBER: { min: 0, max: 0, hint: 'ROW_NUMBER() — 1, 2, 3 … in a table' },
};
export const FUNCTION_HELP = Object.values(FUNCTIONS).map(f => f.hint);

/** Parse formula text to a stored expression. */
export function parseFormula(text: string, fields: FieldResolver, grids?: (key: string) => string | null): Expr {
  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const err = (msg: string, tok = peek()): never => { throw new FormulaError(tok ? `${msg} (at character ${tok.at + 1})` : `${msg} (at the end)`); };
  const take = (t: Tok['t'], v?: string) => {
    const k = peek();
    if (!k || k.t !== t || (v !== undefined && k.v !== v)) err(`Expected ${v ?? t}`);
    p += 1; return k;
  };
  const refs = (e: unknown, out: string[] = []): string[] => {
    if (!e || typeof e !== 'object') return out;
    if (Array.isArray(e)) { e.forEach(x => refs(x, out)); return out; }
    const [[op, a]] = Object.entries(e as Record<string, unknown>);
    if (op === 'f' || op === 'prev') out.push(a as string);
    else if (op === 'sum') refs((a as { of: unknown }).of, out);
    else refs(a, out);
    return out;
  };

  function expr(): Expr {
    let left = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = take('op').v;
      const right = term();
      if (op === '+') left = 'add' in left ? { add: [...(left.add as unknown[]), right] } : { add: [left, right] };
      else left = { sub: [left, right] };
    }
    return left;
  }
  function term(): Expr {
    let left = unary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = take('op').v;
      const right = unary();
      if (op === '*') left = 'mul' in left ? { mul: [...(left.mul as unknown[]), right] } : { mul: [left, right] };
      else left = { div: [left, right] };
    }
    return left;
  }
  function unary(): Expr {
    if (peek()?.t === 'op' && peek().v === '-') { take('op'); return { sub: [{ n: '0' }, unary()] }; }
    return primary();
  }
  function primary(): Expr {
    const k = peek();
    if (!k) return err('The formula ends too early');
    if (k.t === 'num') { p += 1; return { n: k.v }; }
    if (k.t === 'ref') { p += 1; try { return { f: fields.resolve(k.v) }; } catch (e) { return err((e as Error).message, k); } }
    if (k.t === '(') { take('('); const e = expr(); take(')'); return e; }
    if (k.t === 'name') {
      const fn = FUNCTIONS[k.v];
      if (!fn) return err(`Unknown function ${k.v}. Available: ${Object.keys(FUNCTIONS).join(', ')}`, k);
      p += 1; take('(');
      const args: (Expr | Tok)[] = [];
      if (peek()?.t !== ')') {
        do {
          if (k.v === 'PARAM') args.push(take('str'));
          else args.push(expr());
        } while (peek()?.t === ',' && take(','));
      }
      take(')');
      if (args.length < fn.min || args.length > fn.max) return err(`Usage: ${fn.hint}`, k);
      const [a, b] = args as Expr[];
      switch (k.v) {
        case 'PREVIOUS': if (!('f' in a)) return err('PREVIOUS needs a single field, e.g. PREVIOUS([Net Profit])', k); return { prev: a.f };
        case 'SUM': {
          const gs = [...new Set(refs(a).map(r => grids?.(r) ?? null).filter((g): g is string => !!g))];
          if (gs.length !== 1) return err('SUM needs fields from exactly one table', k);
          return { sum: { grid: gs[0], of: a } };
        }
        case 'GROWTH': return { growth: [a, b] };
        case 'PERCENT': return { pct: [a, b] };
        case 'TO_BASE': return { fx_base: [a, b] };
        case 'ROUND': if (!('n' in b) || !/^\d+$/.test(String(b.n))) return err('ROUND needs a whole number of places, e.g. ROUND(x, 0)', k); return { round: [a, Number(b.n)] };
        case 'PARAM': return { cfg: (args[0] as Tok).v };
        case 'ROW_NUMBER': return { row_no: true };
      }
    }
    return err(`Unexpected "${k.v}"`, k);
  }
  if (!toks.length) throw new FormulaError('The formula is empty');
  const out = expr();
  if (p < toks.length) err(`Unexpected "${peek().v}"`);
  return out;
}

const PREC: Record<string, number> = { add: 1, sub: 1, mul: 2, div: 2 };

/** Write a stored expression as formula text (the inverse of parseFormula). */
export function formatFormula(e: unknown, fields: FieldNamer, parent = 0): string {
  const [[op, a]] = Object.entries(e as Record<string, unknown>);
  const f = (x: unknown, prec = 0) => formatFormula(x, fields, prec);
  const wrap = (s: string) => (PREC[op] !== undefined && PREC[op] < parent ? `(${s})` : s);
  const list = a as unknown[];
  switch (op) {
    case 'f': return `[${fields.name(a as string)}]`;
    case 'prev': return `PREVIOUS([${fields.name(a as string)}])`;
    case 'cfg': return `PARAM("${a as string}")`;
    case 'n': return a as string;
    case 'row_no': return 'ROW_NUMBER()';
    case 'add': return wrap(list.map(x => f(x, 1)).join(' + '));
    case 'sub': {
      if ((list[0] as { n?: string }).n === '0') return `-${f(list[1], 3)}`;
      return wrap(`${f(list[0], 1)} - ${f(list[1], 2)}`);
    }
    case 'mul': return wrap(list.map(x => f(x, 2)).join(' * '));
    case 'div': return wrap(`${f(list[0], 2)} / ${f(list[1], 3)}`);
    case 'pct': return `PERCENT(${f(list[0])}, ${f(list[1])})`;
    case 'growth': return `GROWTH(${f(list[0])}, ${f(list[1])})`;
    case 'fx_base': return `TO_BASE(${f(list[0])}, ${f(list[1])})`;
    case 'round': return `ROUND(${f(list[0])}, ${list[1] as number})`;
    case 'sum': return `SUM(${f((a as { of: unknown }).of)})`;
  }
  throw new FormulaError(`Cannot write operator "${op}" as text`);
}
