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
  // guardrail-allow: driver byte value (length / sign byte), not money
  readUInt8(buf: Buffer, offset: number): { offset: number; value: number };
  Result: new (value: unknown, offset: number) => unknown;
  NotEnoughDataError: new (byteCount: number) => unknown;
}
interface TediousValueParser { readValue: (buf: Buffer, offset: number, metadata: { type: { name: string }; scale: number }, options: unknown) => unknown }

let mssqlPatched = false;

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** Scaled integer magnitude of decimal text at the given scale (half-up rounding of extra digits). */
export function toScaledMagnitude(text: string, scale: number): { magnitude: bigint; negative: boolean } {
  const negative = text.startsWith('-');
  const [intPart, frac = ''] = text.replace('-', '').split('.');
  const kept = frac.slice(0, scale).padEnd(scale, '0');
  let magnitude = BigInt(intPart + kept);
  if (frac.length > scale && Number(frac[scale]) >= 5) magnitude += 1n;
  return { magnitude, negative: negative && magnitude !== 0n };
}

interface WriteBuffer { writeUInt8(v: number): void; writeUInt32LE(v: number): void; writeBigUInt64LE(v: bigint): void }
interface TediousDecimalType {
  validate: (value: unknown, ...rest: unknown[]) => unknown;
  writeValue: (buffer: WriteBuffer, parameter: { value: unknown; precision: number; scale: number }, ...rest: unknown[]) => void;
}

/**
 * SQL Server (tedious) writes: the driver's validate() runs parseFloat and writeDecimal() multiplies in
 * floating point. For decimal text, keep the exact text and encode the magnitude with BigInt in the same
 * wire layout (length, sign, little-endian magnitude sized by precision). Numbers fall back to the driver.
 */
export function patchTediousDecimalWrites(type: TediousDecimalType, decimalLength: (precision: number) => number, typeName: string): void {
  const validate = type.validate;
  const writeValue = type.writeValue;
  type.validate = function (value, ...rest) {
    if (typeof value === 'string' && DECIMAL_TEXT.test(value.trim())) return value.trim();
    return validate.call(this, value, ...rest);
  };
  type.writeValue = function (buffer, parameter, ...rest) {
    if (typeof parameter.value !== 'string') return writeValue.call(this, buffer, parameter, ...rest);
    const dataLength = decimalLength(parameter.precision);
    const { magnitude, negative } = toScaledMagnitude(parameter.value, parameter.scale);
    if (magnitude >= 1n << BigInt(8 * dataLength)) {
      throw new RangeError(`Value ${parameter.value} is out of range for ${typeName}(${parameter.precision}, ${parameter.scale}).`);
    }
    const mask64 = (1n << 64n) - 1n;
    buffer.writeUInt8(dataLength + 1);
    buffer.writeUInt8(negative ? 0 : 1);
    if (dataLength === 4) buffer.writeUInt32LE(Number(magnitude));
    else if (dataLength === 8) buffer.writeBigUInt64LE(magnitude);
    else if (dataLength === 12) { buffer.writeBigUInt64LE(magnitude & mask64); buffer.writeUInt32LE(Number(magnitude >> 64n)); }
    else { buffer.writeBigUInt64LE(magnitude & mask64); buffer.writeBigUInt64LE(magnitude >> 64n); }
  };
}

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decimalLength } = require('tedious/lib/data-types/decimal-common');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    patchTediousDecimalWrites(require('tedious/lib/data-types/decimal'), decimalLength, 'Decimal');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    patchTediousDecimalWrites(require('tedious/lib/data-types/numeric'), decimalLength, 'Numeric');
    mssqlPatched = true;
  }
  if (dbType === 'oracle') {
    // TypeORM resets fetchAsString when it connects, so use the fetch type handler, which it leaves alone.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const oracledb = require('oracledb');
    // Only fractional NUMBER columns (our DECIMALs, scale > 0): integers and TypeORM's own catalogue
    // queries keep their numeric types, so schema comparison is unaffected. Oracle omits the leading
    // zero ('.307'); the converter restores it.
    oracledb.fetchTypeHandler = (meta: { dbType: unknown; scale?: number }) =>
      meta.dbType === oracledb.DB_TYPE_NUMBER && (meta.scale ?? 0) > 0
        ? { type: oracledb.STRING, converter: (v: string | null) => (v === null ? v : v.replace(/^(-?)\./, (_m: string, sign: string) => `${sign}0.`)) } : undefined;
  }
}
