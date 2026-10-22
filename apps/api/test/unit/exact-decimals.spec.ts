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
