/**
 * Exact decimal arithmetic for money, rates and ratios (SDD Section 26.1).
 * Values travel through the application as strings and are computed with decimal.js — never
 * with JavaScript floating-point numbers. Scale and rounding mode always come from tenant
 * configuration (currency catalog), never from code.
 */
import Decimal from 'decimal.js';
import { DomainError } from './errors';

// Precision well above DECIMAL(28,8); rounding is applied explicitly per currency, not globally.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -60, toExpPos: 60 });
export type Dec = InstanceType<typeof D>;

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

export function dec(value: string | Dec): Dec {
  if (typeof value === 'string') {
    if (!DECIMAL_TEXT.test(value.trim())) throw new DomainError('invalid_decimal', `"${value}" is not a valid decimal value`);
    return new D(value.trim());
  }
  return value;
}

export function isDecimalText(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_TEXT.test(value.trim());
}

export const ROUNDING_MODES: Record<string, Decimal.Rounding> = {
  half_even: Decimal.ROUND_HALF_EVEN,
  half_up: Decimal.ROUND_HALF_UP,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

export function roundingMode(name: string): Decimal.Rounding {
  const m = ROUNDING_MODES[name];
  if (m === undefined) throw new DomainError('invalid_rounding_mode', `Unknown rounding mode "${name}"`);
  return m;
}

/** Number of digits after the decimal point. */
export function scaleOf(value: string | Dec): number {
  return dec(value).decimalPlaces();
}

/** Canonical string without exponent and without insignificant trailing zeros. */
export function toText(value: Dec): string {
  const s = value.toFixed();
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

export function compare(a: string | Dec, b: string | Dec): number {
  return dec(a).comparedTo(dec(b));
}

export function multiply(a: string | Dec, b: string | Dec): Dec {
  return dec(a).times(dec(b));
}

export function quantize(value: string | Dec, scale: number, mode: string): string {
  return dec(value).toDecimalPlaces(scale, roundingMode(mode)).toFixed(scale);
}
