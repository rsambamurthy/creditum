/**
 * Field attributes (length, format, range, presentation) — configuration in three layers:
 *   core (product defaults) → market profile (e.g. GCC, India) → tenant (the bank's own changes).
 * Each layer overrides only the attributes it sets. A format can depend on another field's value
 * (the ID-number format follows the ID type chosen). Pure: no I/O.
 */
import { dec, isDecimalText } from '../../common/decimal';
import { DomainError } from '../../common/errors';

export type Width = 'xs' | 's' | 'm' | 'l' | 'full';
export interface FormatRule { pattern?: string; patternHint?: string; minLength?: number; maxLength?: number; transform?: 'upper' | 'lower'; placeholder?: string }
export interface FieldAttributes extends FormatRule {
  maxDecimals?: number; minValue?: string; maxValue?: string;
  width?: Width; rows?: number;
  /** Format rules by the value of another field (same row or record), e.g. ID number by ID type. */
  variants?: { dependsOn: string; cases: Record<string, FormatRule> };
}

const WIDTHS = ['xs', 's', 'm', 'l', 'full'];
const RULE_KEYS = ['pattern', 'patternHint', 'minLength', 'maxLength', 'transform', 'placeholder'];
const KEYS = [...RULE_KEYS, 'maxDecimals', 'minValue', 'maxValue', 'width', 'rows', 'variants'];
// guardrail-allow: size bound on an administrator-supplied regular expression (protects the server), not a business limit
const PATTERN_MAX = 200;

/** Layers merged left to right; a later layer replaces only what it sets (variant cases merge per case). */
export function mergeAttributes(...layers: (FieldAttributes | null | undefined)[]): FieldAttributes {
  const out: FieldAttributes = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined) continue;
      if (k === 'variants' && v && out.variants && out.variants.dependsOn === (v as FieldAttributes['variants'])!.dependsOn) {
        const cases = { ...out.variants.cases };
        for (const [code, rule] of Object.entries((v as NonNullable<FieldAttributes['variants']>).cases)) cases[code] = { ...(cases[code] ?? {}), ...rule };
        out.variants = { dependsOn: out.variants.dependsOn, cases };
      } else (out as Record<string, unknown>)[k] = v === null ? undefined : v;
    }
  }
  for (const k of Object.keys(out)) if ((out as Record<string, unknown>)[k] === undefined) delete (out as Record<string, unknown>)[k];
  return out;
}

/** Reject patterns that are invalid, oversized or prone to catastrophic backtracking (nested quantifiers). */
function checkPattern(p: unknown, where: string) {
  const bad = (why: string): never => { throw new DomainError('invalid_attributes', `${where}: ${why}`); };
  if (typeof p !== 'string' || !p) bad('the format must be a regular expression written as text');
  const s = p as string;
  if (s.length > PATTERN_MAX) bad(`the format is longer than ${PATTERN_MAX} characters`);
  if (!s.startsWith('^') || !s.endsWith('$')) bad('the format must describe the whole value: start it with ^ and end it with $');
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(s) || /\\[1-9]/.test(s) || /\(\?[=!<]/.test(s)) bad('nested repetition, back-references and look-arounds are not allowed in formats');
  try { new RegExp(s); } catch { bad('the format is not a valid regular expression'); }
}

function checkRule(r: unknown, where: string) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DomainError('invalid_attributes', `${where}: expected an object`);
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!RULE_KEYS.includes(k)) throw new DomainError('invalid_attributes', `${where}: "${k}" is not a format attribute`);
  if (o.pattern !== undefined && o.pattern !== null) checkPattern(o.pattern, where);
  for (const k of ['minLength', 'maxLength']) {
    const v = o[k];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || (v as number) < 0)) throw new DomainError('invalid_attributes', `${where}: ${k} must be a whole number`);
  }
  if (Number.isInteger(o.minLength) && Number.isInteger(o.maxLength) && (o.minLength as number) > (o.maxLength as number)) {
    throw new DomainError('invalid_attributes', `${where}: the minimum length is larger than the maximum length`);
  }
  if (o.transform !== undefined && o.transform !== null && o.transform !== 'upper' && o.transform !== 'lower') throw new DomainError('invalid_attributes', `${where}: transform must be upper or lower`);
  for (const k of ['patternHint', 'placeholder']) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') throw new DomainError('invalid_attributes', `${where}: ${k} must be text`);
}

/** Validate an attribute document (any layer). null values mean "remove this attribute at this layer". */
export function validateAttributes(a: unknown, label: string, kind: 'text' | 'decimal' | 'other', fieldExists: (key: string) => boolean): void {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new DomainError('invalid_attributes', `${label}: attributes must be an object`);
  const o = a as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw new DomainError('invalid_attributes', `${label}: "${k}" is not a field attribute`);
  const { variants, maxDecimals, minValue, maxValue, width, rows, ...rule } = o;
  checkRule(Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== null)), label);
  if (kind !== 'text' && (rule.pattern || rule.minLength || rule.maxLength || rule.transform)) {
    throw new DomainError('invalid_attributes', `${label}: length and format apply to text fields only`);
  }
  if (maxDecimals !== undefined && maxDecimals !== null && (!Number.isInteger(maxDecimals) || (maxDecimals as number) < 0)) throw new DomainError('invalid_attributes', `${label}: decimal places must be a whole number`);
  for (const [k, v] of [['minValue', minValue], ['maxValue', maxValue]] as const) {
    if (v !== undefined && v !== null && !isDecimalText(v)) throw new DomainError('invalid_attributes', `${label}: ${k} must be a decimal number written as text`);
  }
  if (isDecimalText(minValue) && isDecimalText(maxValue) && dec(minValue).gt(dec(maxValue))) throw new DomainError('invalid_attributes', `${label}: the minimum value is larger than the maximum value`);
  if ((maxDecimals != null || minValue != null || maxValue != null) && kind !== 'decimal') throw new DomainError('invalid_attributes', `${label}: decimal places and value ranges apply to number fields only`);
  if (width !== undefined && width !== null && !WIDTHS.includes(String(width))) throw new DomainError('invalid_attributes', `${label}: width must be one of ${WIDTHS.join(', ')}`);
  if (rows !== undefined && rows !== null && (!Number.isInteger(rows) || (rows as number) < 1)) throw new DomainError('invalid_attributes', `${label}: rows must be a whole number of at least 1`);
  if (variants !== undefined && variants !== null) {
    const v = variants as { dependsOn?: unknown; cases?: unknown };
    if (typeof v.dependsOn !== 'string' || !fieldExists(v.dependsOn)) throw new DomainError('invalid_attributes', `${label}: the format depends on an unknown field`);
    if (!v.cases || typeof v.cases !== 'object') throw new DomainError('invalid_attributes', `${label}: variants need cases`);
    for (const [code, r] of Object.entries(v.cases as Record<string, unknown>)) checkRule(r, `${label} (when ${v.dependsOn} is ${code})`);
  }
}

/** The format rule in force for a value, given the value of the field it depends on. */
export function ruleFor(a: FieldAttributes, dependsOnValue: unknown): FormatRule {
  const base: FormatRule = { pattern: a.pattern, patternHint: a.patternHint, minLength: a.minLength, maxLength: a.maxLength, transform: a.transform, placeholder: a.placeholder };
  const c = a.variants && typeof dependsOnValue === 'string' ? a.variants.cases[dependsOnValue] : undefined;
  return c ? { ...base, ...c } : base;
}

/** Normalise (case transform) and check a value; returns the value to store or throws with a plain reason. */
export function applyAttributes(value: string | boolean, a: FieldAttributes, kind: 'text' | 'decimal' | 'other', dependsOnValue: unknown, label: string): string | boolean {
  const bad = (why: string): never => { throw new DomainError('invalid_value', `${label}: ${why}`); };
  if (typeof value !== 'string') return value;
  if (kind === 'text') {
    const r = ruleFor(a, dependsOnValue);
    const v = r.transform === 'upper' ? value.toUpperCase() : r.transform === 'lower' ? value.toLowerCase() : value;
    const len = [...v].length;
    if (r.maxLength !== undefined && len > r.maxLength) bad(`at most ${r.maxLength} characters (${len} entered)`);
    if (r.minLength !== undefined && len < r.minLength) bad(`at least ${r.minLength} characters`);
    if (r.pattern && !new RegExp(r.pattern).test(v)) bad(`not in the expected format${r.patternHint ? ` — e.g. ${r.patternHint}` : ''}`);
    return v;
  }
  if (kind === 'decimal' && isDecimalText(value)) {
    const d = dec(value);
    if (a.maxDecimals !== undefined && d.decimalPlaces() > a.maxDecimals) bad(a.maxDecimals === 0 ? 'a whole number is expected' : `at most ${a.maxDecimals} decimal places`);
    if (a.minValue !== undefined && d.lt(dec(a.minValue))) bad(`must be at least ${a.minValue}`);
    if (a.maxValue !== undefined && d.gt(dec(a.maxValue))) bad(`must be at most ${a.maxValue}`);
  }
  return value;
}
