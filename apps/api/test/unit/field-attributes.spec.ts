import { applyAttributes, mergeAttributes, ruleFor, validateAttributes, FieldAttributes } from '../../src/modules/field-registry/field-attributes';

const core: FieldAttributes = { maxLength: 50, width: 's' };
const india: FieldAttributes = { variants: { dependsOn: 'id_type', cases: { pan: { pattern: '^[A-Z]{5}\\d{4}[A-Z]$', patternHint: 'ABCDE1234F', maxLength: 10, transform: 'upper' } } } };

describe('field attributes', () => {
  it('merges product → market → bank, each layer changing only what it sets', () => {
    const bank: FieldAttributes = { width: 'm', variants: { dependsOn: 'id_type', cases: { pan: { patternHint: 'PAN of the borrower' }, cin: { maxLength: 21 } } } };
    const eff = mergeAttributes(core, india, bank);
    expect(eff.maxLength).toBe(50);
    expect(eff.width).toBe('m');
    expect(eff.variants!.cases.pan).toEqual({ pattern: '^[A-Z]{5}\\d{4}[A-Z]$', patternHint: 'PAN of the borrower', maxLength: 10, transform: 'upper' });
    expect(eff.variants!.cases.cin).toEqual({ maxLength: 21 });
    expect(mergeAttributes(core, { maxLength: null } as unknown as FieldAttributes).maxLength).toBeUndefined(); // a bank can remove an inherited limit
  });

  it('applies the format of the chosen variant, normalising case', () => {
    const eff = mergeAttributes(core, india);
    expect(ruleFor(eff, 'pan').maxLength).toBe(10);
    expect(applyAttributes('abcde1234f', eff, 'text', 'pan', 'ID number')).toBe('ABCDE1234F');
    expect(() => applyAttributes('ABCDE12345', eff, 'text', 'pan', 'ID number')).toThrow(/not in the expected format — e.g. ABCDE1234F/);
    expect(applyAttributes('any-other-id', eff, 'text', 'passport', 'ID number')).toBe('any-other-id'); // no variant: base rule (length only)
    expect(() => applyAttributes('x'.repeat(51), eff, 'text', undefined, 'ID number')).toThrow(/at most 50 characters \(51 entered\)/);
  });

  it('checks ranges and decimal places of numbers exactly', () => {
    const share: FieldAttributes = { minValue: '0', maxValue: '100', maxDecimals: 2 };
    expect(applyAttributes('100', share, 'decimal', undefined, 'Ownership')).toBe('100');
    expect(() => applyAttributes('100.01', share, 'decimal', undefined, 'Ownership')).toThrow(/at most 100/);
    expect(() => applyAttributes('-0.5', share, 'decimal', undefined, 'Ownership')).toThrow(/at least 0/);
    expect(() => applyAttributes('12.345', share, 'decimal', undefined, 'Ownership')).toThrow(/at most 2 decimal places/);
  });

  it('rejects unsafe or inconsistent attribute definitions', () => {
    const ok = () => true;
    expect(() => validateAttributes({ pattern: '^(a+)+$' }, 'F', 'text', ok)).toThrow(/nested repetition/);
    expect(() => validateAttributes({ pattern: 'abc' }, 'F', 'text', ok)).toThrow(/start it with \^/);
    expect(() => validateAttributes({ pattern: '^[a-$' }, 'F', 'text', ok)).toThrow(/not a valid regular expression/);
    expect(() => validateAttributes({ minLength: 5, maxLength: 3 }, 'F', 'text', ok)).toThrow(/minimum length is larger/);
    expect(() => validateAttributes({ maxLength: 3 }, 'F', 'decimal', ok)).toThrow(/text fields only/);
    expect(() => validateAttributes({ minValue: 1 }, 'F', 'decimal', ok)).toThrow(/decimal number written as text/);
    expect(() => validateAttributes({ colour: 'red' }, 'F', 'text', ok)).toThrow(/not a field attribute/);
    expect(() => validateAttributes({ variants: { dependsOn: 'nope', cases: {} } }, 'F', 'text', () => false)).toThrow(/unknown field/);
    expect(() => validateAttributes({ maxLength: 12, width: 'l', variants: { dependsOn: 'id_type', cases: { civil_id: { pattern: '^\\d{12}$' } } } }, 'F', 'text', ok)).not.toThrow();
  });
});
