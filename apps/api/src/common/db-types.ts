/**
 * Portable column definitions (SDD Section 19.6).
 *
 * Every entity and migration takes its column types from here, so the same code runs on
 * PostgreSQL, Microsoft SQL Server and Oracle. Nothing else in the codebase may name a
 * database-specific type.
 *
 * Design decisions:
 *  - Identifiers are 36-character strings (UUID text), not native UUID types, which differ per engine.
 *  - Exact numbers (amounts, rates, ratios) are DECIMAL/NUMBER and are always surfaced to the
 *    application as strings, never as JavaScript floating-point numbers (SDD Section 26.1).
 *  - JSON documents (rule and workflow definitions) are stored as text and parsed by the
 *    application; the database never queries inside them.
 *  - Booleans are mapped per engine (boolean / bit / number(1)) and normalised to true/false.
 */
import { ColumnOptions, PrimaryColumnOptions, ValueTransformer } from 'typeorm';

export type DbType = 'postgres' | 'mssql' | 'oracle';

export function currentDbType(): DbType {
  const t = (process.env.DB_TYPE ?? 'postgres').toLowerCase();
  if (t !== 'postgres' && t !== 'mssql' && t !== 'oracle') {
    throw new Error(`Unsupported DB_TYPE "${t}". Supported: postgres, mssql, oracle.`);
  }
  return t;
}

const db = currentDbType();

/** Exact decimal: database value -> canonical string; application string -> database. */
export const decimalTransformer: ValueTransformer = {
  to: (v: string | null | undefined) => (v === undefined ? undefined : v),
  from: (v: unknown) => {
    if (v === null || v === undefined) return null;
    // Some drivers return numbers for DECIMAL; convert without exponent notation.
    const s = typeof v === 'number' ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : String(v);
    return normaliseDecimalString(s);
  },
};

/** Remove insignificant trailing zeros so values compare equally across engines ("10.5000" -> "10.5"). */
export function normaliseDecimalString(input: string): string {
  const s = input.replace(/^(-?)\./, (_m: string, sign: string) => `${sign}0.`); // some engines omit the leading zero (".307")
  if (!s.includes('.')) return s;
  const out = s.replace(/0+$/, '').replace(/\.$/, '');
  return out === '-0' ? '0' : out;
}

export const intTransformer: ValueTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: unknown) => (v === null || v === undefined ? v : Number(v)),
};

export const boolTransformer: ValueTransformer = {
  to: (v: boolean | null | undefined) => (v === null || v === undefined ? v : db === 'oracle' ? (v ? 1 : 0) : v),
  from: (v: unknown) => (v === null || v === undefined ? v : v === true || v === 1 || v === '1' || v === 't' || v === 'true'),
};

type Opt = Partial<ColumnOptions>;

function strType(): ColumnOptions['type'] {
  return db === 'mssql' ? 'nvarchar' : db === 'oracle' ? 'nvarchar2' : 'varchar';
}

export const T = {
  /** Primary key: 36-character identifier (UUID text). */
  pk: (): PrimaryColumnOptions => ({ type: strType() as PrimaryColumnOptions['type'], length: 36 }),
  /** 36-character identifier (UUID text). */
  id: (o: Opt = {}): ColumnOptions => ({ type: strType(), length: 36, ...o }),
  /** Bounded string. */
  str: (length: number, o: Opt = {}): ColumnOptions => ({ type: strType(), length, ...o }),
  /** Unbounded text (JSON documents, rich text, audit payloads). */
  text: (o: Opt = {}): ColumnOptions =>
    db === 'postgres' ? { type: 'text', ...o } : db === 'mssql' ? { type: 'nvarchar', length: 'MAX', ...o } : { type: 'nclob', ...o },
  /** Exact decimal, surfaced as string. Default 28,8 covers amounts, rates and ratios. */
  dec: (precision = 28, scale = 8, o: Opt = {}): ColumnOptions => ({
    type: db === 'oracle' ? 'number' : 'decimal', precision, scale, transformer: decimalTransformer, ...o,
  }),
  int: (o: Opt = {}): ColumnOptions =>
    db === 'oracle' ? { type: 'number', precision: 10, scale: 0, transformer: intTransformer, ...o } : { type: 'int', transformer: intTransformer, ...o },
  bigint: (o: Opt = {}): ColumnOptions =>
    db === 'oracle' ? { type: 'number', precision: 19, scale: 0, transformer: intTransformer, ...o } : { type: 'bigint', transformer: intTransformer, ...o },
  bool: (o: Opt = {}): ColumnOptions =>
    db === 'postgres' ? { type: 'boolean', transformer: boolTransformer, ...o }
      : db === 'mssql' ? { type: 'bit', transformer: boolTransformer, ...o }
        : { type: 'number', precision: 1, scale: 0, transformer: boolTransformer, ...o },
  /** UTC timestamp. */
  ts: (o: Opt = {}): ColumnOptions =>
    db === 'postgres' ? { type: 'timestamptz', ...o } : db === 'mssql' ? { type: 'datetime2', ...o } : { type: 'timestamp', ...o },
};

/** Value stored in owner_scope for shared core-library rows (portable alternative to NULL in unique keys). */
export const CORE_SCOPE = 'core';
