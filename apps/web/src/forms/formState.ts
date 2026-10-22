/**
 * Client-side state of the Credit Request module screens. Pure functions only: the layout decides what exists,
 * values stay as the API sends them (decimal strings, booleans, YYYY-MM-DD dates) and are never converted to numbers.
 */
import type { FieldMeta, FormValue, GridRowData, Layout, RequestData, RequestDataInput } from '../api';

/** A grid row on screen. `id` is a client-only identity (the server rowKey, or a temporary id for new rows). */
export interface LocalRow { id: string; rowKey?: string; values: Record<string, FormValue> }
export interface FormState { record: Record<string, FormValue>; grids: Record<string, LocalRow[]> }

const DECIMAL = /^-?\d+(\.\d+)?$/;
let tmp = 0;
export const newRowId = () => `new-${Date.now().toString(36)}-${++tmp}`;

export function fromData(d: RequestData): FormState {
  const grids: Record<string, LocalRow[]> = {};
  for (const [g, rows] of Object.entries(d.grids ?? {})) {
    grids[g] = rows.map(r => ({ id: r.rowKey ?? newRowId(), rowKey: r.rowKey, values: { ...r.values } }));
  }
  return { record: { ...(d.record ?? {}) }, grids };
}

/** Blank values compare equal whatever their representation. */
export function norm(v: FormValue | undefined): FormValue {
  return v === undefined || v === '' ? null : v;
}
export const isBlank = (v: FormValue | undefined) => norm(v) === null;

/** Everything the layout says about a field, plus where it lives. */
export interface PlacedField { meta: FieldMeta; module: string; section: string; grid: string | null }

export interface LayoutIndex {
  fields: Map<string, PlacedField>;
  /** Keys (record level, composite parts included) and grid columns that must never be sent. */
  readOnly: Set<string>;
  /** Module(s) showing each grid (the financial periods grid is shared by several sections of one module). */
  gridModules: Map<string, Set<string>>;
  /** Value keys of a field: the key itself, or key:part for composites. */
  valueKeys: (f: FieldMeta) => string[];
}

export function valueKeys(f: FieldMeta): string[] {
  return f.valueKind === 'composite' && f.parts?.length ? f.parts.map(p => `${f.key}:${p}`) : [f.key];
}

export function indexLayout(layout: Layout): LayoutIndex {
  const fields = new Map<string, PlacedField>();
  const readOnly = new Set<string>();
  const gridModules = new Map<string, Set<string>>();
  for (const m of layout.modules) {
    for (const s of m.sections) {
      const put = (f: FieldMeta, grid: string | null) => {
        fields.set(f.key, { meta: f, module: m.code, section: s.code, grid });
        if (f.readOnly || f.valueKind === 'none') valueKeys(f).forEach(k => readOnly.add(k));
      };
      s.fields.forEach(f => put(f, null));
      if (s.kind !== 'record' && s.grid) {
        (s.columns ?? []).forEach(f => put(f, s.grid));
        if (!gridModules.has(s.grid)) gridModules.set(s.grid, new Set());
        gridModules.get(s.grid)!.add(m.code);
      }
    }
  }
  return { fields, readOnly, gridModules, valueKeys };
}

/** Field key of a value key ("…bracket_1:from" -> "…bracket_1"). */
export const fieldOf = (valueKey: string) => valueKey.split(':')[0];

function rowsEqual(a: LocalRow[] | undefined, b: LocalRow[] | undefined, readOnly: Set<string>): boolean {
  const x = a ?? []; const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i].id !== y[i].id) return false;
    const keys = new Set([...Object.keys(x[i].values), ...Object.keys(y[i].values)]);
    for (const k of keys) if (!readOnly.has(k) && norm(x[i].values[k]) !== norm(y[i].values[k])) return false;
  }
  return true;
}

export interface Changes { record: string[]; grids: string[] }

export function changes(orig: FormState, cur: FormState, idx: LayoutIndex): Changes {
  const recKeys = new Set([...Object.keys(orig.record), ...Object.keys(cur.record)]);
  const record = [...recKeys].filter(k => !idx.readOnly.has(k) && norm(orig.record[k]) !== norm(cur.record[k]));
  const gridKeys = new Set([...Object.keys(orig.grids), ...Object.keys(cur.grids)]);
  const grids = [...gridKeys].filter(g => !rowsEqual(orig.grids[g], cur.grids[g], idx.readOnly));
  return { record, grids };
}

/** Modules with unsaved changes. */
export function dirtyModules(ch: Changes, idx: LayoutIndex): Set<string> {
  const out = new Set<string>();
  for (const k of ch.record) { const p = idx.fields.get(fieldOf(k)); if (p) out.add(p.module); }
  for (const g of ch.grids) idx.gridModules.get(g)?.forEach(m => out.add(m));
  return out;
}

/** PUT body: only changed record keys, and the full arrays of changed grids (rowKey kept, new rows without one). */
export function payload(expectedVersion: number, cur: FormState, ch: Changes, idx: LayoutIndex): RequestDataInput {
  const body: RequestDataInput = { expectedVersion };
  if (ch.record.length) body.record = Object.fromEntries(ch.record.map(k => [k, norm(cur.record[k])]));
  if (ch.grids.length) {
    body.grids = Object.fromEntries(ch.grids.map(g => [g, (cur.grids[g] ?? []).map((r): GridRowData => {
      const values = Object.fromEntries(Object.entries(r.values).filter(([k]) => !idx.readOnly.has(k)).map(([k, v]) => [k, norm(v)]));
      return r.rowKey ? { rowKey: r.rowKey, values } : { values };
    })]));
  }
  return body;
}

/** Decimal-typed values (record and grid cells) that are not decimal text. Keys are "key" or "key@rowId". */
export function invalidDecimals(cur: FormState, idx: LayoutIndex): Set<string> {
  const bad = new Set<string>();
  const check = (meta: FieldMeta | undefined, valueKey: string, v: FormValue | undefined, suffix: string) => {
    if (!meta || meta.readOnly) return;
    const decimal = meta.valueKind === 'decimal' || meta.valueKind === 'composite';
    if (decimal && typeof v === 'string' && v.trim() !== '' && !DECIMAL.test(v.trim())) bad.add(valueKey + suffix);
  };
  for (const [k, v] of Object.entries(cur.record)) check(idx.fields.get(fieldOf(k))?.meta, k, v, '');
  for (const rows of Object.values(cur.grids)) {
    for (const r of rows) for (const [k, v] of Object.entries(r.values)) check(idx.fields.get(fieldOf(k))?.meta, k, v, `@${r.id}`);
  }
  return bad;
}

export const isDecimalText = (s: string) => DECIMAL.test(s);
