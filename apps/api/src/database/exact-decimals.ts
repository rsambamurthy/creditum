/**
 * Exact DECIMAL / NUMERIC reads on every engine (SDD Section 26.1, ADR 0001).
 *
 * PostgreSQL returns DECIMAL as text already. The SQL Server and Oracle drivers convert to a
 * JavaScript number by default, which silently loses precision beyond ~15 significant digits.
 * This module makes both return exact decimal text. It is covered by unit tests (wire-format bytes)
 * and by the integration round-trip test that CI runs on all three engines.
 */
import { DbType } from '../common/db-types';

/** Format an unsigned integer magnitude with a decimal scale as exact text. */
export function scaledText(magnitude: bigint, scale: number, negative: boolean): string {
  let digits = magnitude.toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  }
  return negative && magnitude !== 0n ? `-${digits}` : digits;
}

interface TediousHelpers {
  readUInt8(buf: Buffer, offset: number): { offset: number; value: number };
  Result: new (value: unknown, offset: number) => unknown;
  NotEnoughDataError: new (byteCount: number) => unknown;
}
interface TediousValueParser { readValue: (buf: Buffer, offset: number, metadata: { type: { name: string }; scale: number }, options: unknown) => unknown }

let mssqlPatched = false;

/**
 * SQL Server (tedious): DECIMAL/NUMERIC arrive as a sign byte plus a 4/8/12/16-byte little-endian
 * unsigned integer. Read that integer with BigInt and format it with the column's scale, instead of
 * the driver's floating-point division. All other types are delegated to the original parser.
 */
export function patchTediousDecimals(valueParser: TediousValueParser, helpers: TediousHelpers): void {
  const original = valueParser.readValue;
  valueParser.readValue = (buf, offset, metadata, options) => {
    const name = metadata?.type?.name;
    if (name !== 'DecimalN' && name !== 'NumericN') return original(buf, offset, metadata, options);
    const len = helpers.readUInt8(buf, offset);
    if (len.value === 0) return new helpers.Result(null, len.offset);
    const start = len.offset;
    if (buf.length < start + len.value) throw new helpers.NotEnoughDataError(start + len.value);
    const negative = buf.readUInt8(start) !== 1;
    let magnitude = 0n;
    for (let i = start + len.value - 1; i > start; i -= 1) magnitude = (magnitude << 8n) | BigInt(buf[i]);
    return new helpers.Result(scaledText(magnitude, metadata.scale, negative), start + len.value);
  };
}

export function applyExactDecimalReads(dbType: DbType): void {
  if (dbType === 'mssql' && !mssqlPatched) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    patchTediousDecimals(require('tedious/lib/value-parser'), require('tedious/lib/token/helpers'));
    mssqlPatched = true;
  }
  if (dbType === 'oracle') {
    // TypeORM resets fetchAsString when it connects, so use the fetch type handler, which it leaves alone.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const oracledb = require('oracledb');
    oracledb.fetchTypeHandler = (meta: { dbType: unknown }) =>
      meta.dbType === oracledb.DB_TYPE_NUMBER || meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB
        ? { type: oracledb.STRING } : undefined;
  }
}
