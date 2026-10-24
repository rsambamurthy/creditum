/**
 * Field attributes (length, format, range, presentation) — the web side of
 * apps/api/src/modules/field-registry/field-attributes.ts. The server stays the authority (it re-checks on save);
 * the screen uses the same rules to limit, hint and check as the user types. Decimals stay text throughout.
 */

export type Width = 'xs' | 's' | 'm' | 'l' | 'full';
export interface FormatRule {
  pattern?: string | null; patternHint?: string | null; minLength?: number | null; maxLength?: number | null;
  transform?: 'upper' | 'lower' | null; placeholder?: string | null;
}
export interface FieldAttributes extends FormatRule {
  maxDecimals?: number | null; minValue?: string | null; maxValue?: string | null;
  width?: Width | null; rows?: number | null;
  variants?: { dependsOn: string; cases: Record<string, FormatRule> } | null;
}

export const WIDTHS: Width[] = ['xs', 's', 'm', 'l', 'full'];
export const RULE_KEYS = ['pattern', 'patternHint', 'minLength', 'maxLength', 'transform', 'placeholder'] as const;

/** Layers merged left to right; a later layer replaces only what it sets; null removes (variant cases merge per case). */
export function mergeAttributes(...layers: (FieldAttributes | null | undefined)[]): FieldAttributes {
  const out: Record<string, unknown> = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined) continue;
      const cur = out.variants as FieldAttributes['variants'];
      if (k === 'variants' && v && cur && cur.dependsOn === (v as NonNullable<FieldAttributes['variants']>).dependsOn) {
        const cases = { ...cur.cases };
        for (const [code, rule] of Object.entries((v as NonNullable<FieldAttributes['variants']>).cases)) cases[code] = { ...(cases[code] ?? {}), ...rule };
        out.variants = { dependsOn: cur.dependsOn, cases };
      } else out[k] = v === null ? undefined : v;
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as FieldAttributes;
}

/** The format rule in force for a value, given the value of the field it depends on (same row or record). */
export function ruleFor(a: FieldAttributes | undefined, dependsOnValue: unknown): FormatRule {
  if (!a) return {};
  const base: FormatRule = { pattern: a.pattern, patternHint: a.patternHint, minLength: a.minLength, maxLength: a.maxLength, transform: a.transform, placeholder: a.placeholder };
  const c = a.variants && typeof dependsOnValue === 'string' ? a.variants.cases[dependsOnValue] : undefined;
  return c ? { ...base, ...c } : base;
}

export function transformText(v: string, r: FormatRule): string {
  return r.transform === 'upper' ? v.toUpperCase() : r.transform === 'lower' ? v.toLowerCase() : v;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const charCount = (s: string) => [...s].length;

/** Significant decimal places ("1.2500" -> 2), like Decimal.decimalPlaces(). */
export function decimalPlaces(v: string): number {
  const i = v.indexOf('.');
  return i < 0 ? 0 : v.slice(i + 1).replace(/0+$/, '').length;
}

/** Compare two decimal texts exactly, without converting to numbers: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): number {
  const parse = (s: string) => {
    const neg = s.startsWith('-');
    const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
    const int = i.replace(/^0+(?=\d)/, '');
    const frac = f.replace(/0+$/, '');
    const zero = /^0*$/.test(int) && frac === '';
    return { neg: neg && !zero, int, frac };
  };
  const x = parse(a); const y = parse(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const sign = x.neg ? -1 : 1;
  if (x.int.length !== y.int.length) return (x.int.length > y.int.length ? 1 : -1) * sign;
  if (x.int !== y.int) return (x.int > y.int ? 1 : -1) * sign;
  const n = Math.max(x.frac.length, y.frac.length);
  const fx = x.frac.padEnd(n, '0'); const fy = y.frac.padEnd(n, '0');
  if (fx === fy) return 0;
  return (fx > fy ? 1 : -1) * sign;
}

export type AttrKind = 'text' | 'decimal' | 'other';

/** A plain reason the value breaks the attributes, or null. Mirrors the server's applyAttributes. */
export function checkValue(value: unknown, a: FieldAttributes | undefined, kind: AttrKind, dependsOnValue: unknown): string | null {
  if (!a || typeof value !== 'string' || value === '') return null;
  if (kind === 'text') {
    const r = ruleFor(a, dependsOnValue);
    const v = transformText(value, r);
    const len = charCount(v);
    if (r.maxLength != null && len > r.maxLength) return `At most ${r.maxLength} characters (${len} entered)`;
    if (r.minLength != null && len < r.minLength) return `At least ${r.minLength} characters`;
    if (r.pattern) {
      let ok = true;
      try { ok = new RegExp(r.pattern).test(v); } catch { ok = true; }
      if (!ok) return `Not in the expected format${r.patternHint ? ` — e.g. ${r.patternHint}` : ''}`;
    }
    return null;
  }
  if (kind === 'decimal' && DECIMAL.test(value.trim())) {
    const v = value.trim();
    if (a.maxDecimals != null && decimalPlaces(v) > a.maxDecimals) return a.maxDecimals === 0 ? 'A whole number is expected' : `At most ${a.maxDecimals} decimal places`;
    if (a.minValue != null && compareDecimal(v, a.minValue) < 0) return `Must be at least ${a.minValue}`;
    if (a.maxValue != null && compareDecimal(v, a.maxValue) > 0) return `Must be at most ${a.maxValue}`;
  }
  return null;
}

/** Kind used by the attribute rules for a library data type / value kind. */
export function attrKind(valueKind: string | undefined, dataType?: string): AttrKind {
  if (valueKind === 'decimal') return 'decimal';
  if (valueKind === 'text' && dataType !== 'Dropdown' && dataType !== 'Currency Code') return 'text';
  return 'other';
}

/** Columns a width spans in the 4-column record grid. */
export const WIDTH_SPAN: Record<Width, number> = { xs: 1, s: 1, m: 2, l: 3, full: 4 };
/** Minimum column width in tables, by width. */
export const WIDTH_MIN_PX: Record<Width, number> = { xs: 90, s: 140, m: 200, l: 280, full: 360 };
