import { patchTediousDecimals, scaledText } from '../../src/database/exact-decimals';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helpers = require('tedious/lib/token/helpers');

/** Encode a decimal the way SQL Server sends it: length byte, sign byte, little-endian magnitude. */
function wire(text: string, scale: number, size: 4 | 8 | 12 | 16): Buffer {
  const negative = text.startsWith('-');
  const [i, f = ''] = text.replace('-', '').split('.');
  let mag = BigInt(i + f.padEnd(scale, '0'));
  const out = Buffer.alloc(2 + size);
  out.writeUInt8(1 + size, 0);
  out.writeUInt8(negative ? 0 : 1, 1);
  for (let k = 0; k < size; k += 1) { out[2 + k] = Number(mag & 0xffn); mag >>= 8n; }
  return out;
}

describe('exact DECIMAL reads for SQL Server (tedious)', () => {
  const parser = { readValue: jest.fn(() => 'delegated') } as unknown as { readValue: (...a: unknown[]) => unknown };
  patchTediousDecimals(parser as never, helpers);
  const read = (buf: Buffer, scale: number) => (parser.readValue(buf, 0, { type: { name: 'DecimalN' }, scale }, {}) as { value: unknown }).value;

  it('reads 28-digit values exactly (where the stock driver returns 12345678901234567000)', () => {
    expect(read(wire('12345678901234567890.12345678', 8, 16), 8)).toBe('12345678901234567890.12345678');
  });
  it('handles negatives, small values, zero, every storage size and NULL', () => {
    expect(read(wire('-0.00000001', 8, 4), 8)).toBe('-0.00000001');
    expect(read(wire('307000.125', 3, 8), 3)).toBe('307000.125');
    expect(read(wire('0', 2, 12), 2)).toBe('0.00');
    expect(read(wire('99999999999999999999.99999999', 8, 16), 8)).toBe('99999999999999999999.99999999');
    expect((parser.readValue(Buffer.from([0]), 0, { type: { name: 'NumericN' }, scale: 2 }, {}) as { value: unknown }).value).toBeNull();
  });
  it('asks for more data when the value is split across packets', () => {
    const full = wire('1.5', 1, 16);
    expect(() => parser.readValue(full.subarray(0, 5), 0, { type: { name: 'DecimalN' }, scale: 1 }, {})).toThrow();
  });
  it('leaves every other type to the driver', () => {
    expect(parser.readValue(Buffer.alloc(4), 0, { type: { name: 'Int' }, scale: 0 }, {})).toBe('delegated');
  });
  it('formats scaled integers', () => {
    expect(scaledText(5n, 3, false)).toBe('0.005');
    expect(scaledText(5n, 0, true)).toBe('-5');
  });
});

describe('exact DECIMAL writes for SQL Server (tedious)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { patchTediousDecimalWrites, toScaledMagnitude } = require('../../src/database/exact-decimals');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { decimalLength } = require('tedious/lib/data-types/decimal-common');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WritableTrackingBuffer = require('tedious/lib/tracking-buffer/writable-tracking-buffer');
  // Fresh copy of the driver's Decimal type so this test does not depend on global patching order.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Decimal = { ...require('tedious/lib/data-types/decimal') };

  it('the stock driver loses precision on write (the defect being fixed)', () => {
    expect(Decimal.validate('12345678901234567890.12345678')).toBe(12345678901234567000);
  });

  it('writes 28-digit values exactly, and the reader returns them unchanged', () => {
    patchTediousDecimalWrites(Decimal, decimalLength, 'Decimal');
    for (const v of ['12345678901234567890.12345678', '-0.00000001', '307000.125', '0']) {
      const buf = new WritableTrackingBuffer(32);
      Decimal.writeValue(buf, { value: Decimal.validate(v), precision: 28, scale: 8 });
      const parser = { readValue: (() => 'x') as unknown };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../src/database/exact-decimals').patchTediousDecimals(parser, helpers);
      const out = (parser.readValue as (...a: unknown[]) => { value: string })(buf.data, 0, { type: { name: 'DecimalN' }, scale: 8 }, {});
      expect(out.value.replace(/\.?0+$/, '') || '0').toBe(v === '0' ? '0' : v.replace(/\.?0+$/, ''));
    }
  });

  it('rejects values that do not fit the column', () => {
    const buf = new WritableTrackingBuffer(32);
    expect(() => Decimal.writeValue(buf, { value: '1' + '0'.repeat(30), precision: 28, scale: 8 })).toThrow(RangeError);
  });

  it('rounds extra fractional digits half-up, as SQL Server does', () => {
    expect(toScaledMagnitude('1.235', 2).magnitude).toBe(124n);
    expect(toScaledMagnitude('1.234', 2).magnitude).toBe(123n);
  });
});
