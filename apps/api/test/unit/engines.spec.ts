import { evaluateRules, validateRule, evaluateCondition } from '../../src/modules/rules/rule-evaluator';
import { availableTransitions, resolveTransition, validateDefinition, WfDefinition } from '../../src/modules/workflow/workflow-engine';
import { formatRequestNumber, sequenceScope, separatorValue } from '../../src/modules/credit-request/request-number';
import { canonicalJson, recordHash, ChainFields } from '../../src/modules/audit/audit.service';
import { compare, quantize, scaleOf, toText, dec, multiply } from '../../src/common/decimal';
import { normaliseDecimalString } from '../../src/common/db-types';

describe('decimal arithmetic', () => {
  it('is exact where floating point is not', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the problem being avoided
    expect(toText(dec('0.1').plus(dec('0.2')))).toBe('0.3');
    expect(toText(multiply('1000000', '0.307'))).toBe('307000');
  });
  it('compares large values exactly', () => {
    expect(compare('12345678901234567890.12345678', '12345678901234567890.12345679')).toBe(-1);
  });
  it('quantizes with the configured rounding mode', () => {
    expect(quantize('2.0005', 3, 'half_even')).toBe('2.000');
    expect(quantize('2.0005', 3, 'half_up')).toBe('2.001');
    expect(() => quantize('1', 2, 'banker')).toThrow();
  });
  it('reports scale and normalises engine output', () => {
    expect(scaleOf('1000.125')).toBe(3);
    expect(normaliseDecimalString('10.50000000')).toBe('10.5');
    expect(normaliseDecimalString('7.00000000')).toBe('7');
    expect(() => dec('1e5')).toThrow();
  });
});

describe('rules engine', () => {
  const cfg = (k: string) => ({ 'limit.narrative': '250000', 'limit.max': '50000000' } as Record<string, string>)[k];
  const rules = [
    { ruleKey: 'R1', name: 'narrative', condition: { '>': [{ var: 'base_amount' }, { cfg: 'limit.narrative' }] },
      actions: [{ type: 'require' as const, field: 'narrative', message: 'Narrative required' }] },
    { ruleKey: 'R2', name: 'ceiling', condition: { '>': [{ var: 'base_amount' }, { cfg: 'limit.max' }] }, actions: [{ type: 'block' as const, message: 'Too large' }] },
  ];
  it('takes thresholds from configuration, compared as exact decimals', () => {
    const rec = (amount: string) => (k: string) => ({ base_amount: amount } as Record<string, string>)[k];
    expect(evaluateRules(rules, rec('250000'), cfg).fired).toEqual([]);
    expect(evaluateRules(rules, rec('250000.001'), cfg).required.map(r => r.field)).toEqual(['narrative']);
    expect(evaluateRules(rules, rec('50000000.01'), cfg).blocks).toHaveLength(1);
  });
  it('supports boolean logic, membership and emptiness', () => {
    const r = (k: string) => ({ type: 'increase', note: '' } as Record<string, string>)[k];
    expect(evaluateCondition({ and: [{ in: [{ var: 'type' }, ['increase', 'renewal']] }, { empty: { var: 'note' } }] }, r, cfg)).toBe(true);
    expect(evaluateCondition({ not: { '==': [{ var: 'type' }, 'new'] } }, r, cfg)).toBe(true);
  });
  it('rejects malformed rules', () => {
    expect(() => validateRule({ ruleKey: 'X', name: 'x', condition: { between: [1, 2] }, actions: [{ type: 'warn', message: 'm' }] })).toThrow();
    expect(() => validateRule({ ruleKey: 'X', name: 'x', condition: true, actions: [{ type: 'require' }] })).toThrow();
  });
});

describe('workflow engine', () => {
  const def: WfDefinition = {
    initial: 'draft',
    states: [{ code: 'draft', label: 'Draft', editable: true }, { code: 'committee', label: 'Committee' }, { code: 'approved', label: 'Approved', final: true }],
    transitions: [
      { action: 'submit', label: 'Submit', from: 'draft', to: 'committee', roles: ['ro'] },
      { action: 'approve', label: 'Approve', from: 'committee', to: 'approved', roles: ['cm', 'scm'], checker: true, authority: true },
    ],
  };
  it('validates definitions — no undefined or unreachable stages', () => {
    expect(() => validateDefinition(def)).not.toThrow();
    expect(() => validateDefinition({ ...def, transitions: [...def.transitions, { action: 'x', label: 'X', from: 'draft', to: 'S', roles: ['ro'] }] })).toThrow(/undefined state/);
    expect(() => validateDefinition({ ...def, states: [...def.states, { code: 'orphan', label: 'Orphan' }] })).toThrow(/Unreachable/);
  });
  it('enforces roles, segregation of duties and delegated authority', () => {
    const base = { actorId: 'u2', makerId: 'u1', authorityRoles: ['scm'] };
    expect(() => resolveTransition(def, 'committee', 'approve', { ...base, actorRoles: ['ro'] })).toThrow(/role/);
    expect(() => resolveTransition(def, 'committee', 'approve', { ...base, actorRoles: ['cm'] })).toThrow(/authority/);
    expect(() => resolveTransition(def, 'committee', 'approve', { ...base, actorId: 'u1', actorRoles: ['scm'] })).toThrow(/segregation/);
    expect(resolveTransition(def, 'committee', 'approve', { ...base, actorRoles: ['scm'] }).to).toBe('approved');
    expect(availableTransitions(def, 'committee', { ...base, actorRoles: ['cm'] })).toHaveLength(0);
  });
});

describe('request number scheme', () => {
  it('formats from configuration', () => {
    expect(formatRequestNumber({ prefix: 'CR', separator: '-', padding: 6, includeYear: true, reset: 'yearly' }, 2026, 42)).toBe('CR-2026-000042');
    expect(formatRequestNumber({ prefix: 'LA', separator: separatorValue('none'), padding: 5, includeYear: false, reset: 'never' }, 2026, 7)).toBe('LA00007');
    expect(sequenceScope({ prefix: '', separator: '', padding: 1, includeYear: false, reset: 'yearly' }, 2027)).toBe('credit_request:2027');
    expect(() => formatRequestNumber({ prefix: 'X', separator: '-', padding: 0, includeYear: false, reset: 'never' }, 2026, 1)).toThrow();
  });
});

describe('audit hash chain', () => {
  const f: ChainFields = { tenantId: 't', seq: 1, occurredAtUtc: '2026-10-22T10:00:00.000Z', actorId: 'a', actorName: 'A', action: 'x',
    entityType: 'e', entityRef: 'r', beforeData: null, afterData: '{"a":1}', clientIp: null, sessionRef: null, prevHash: '0'.repeat(64) };
  it('canonicalises key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('changes when any field changes', () => {
    expect(recordHash(f)).toBe(recordHash({ ...f }));
    expect(recordHash({ ...f, afterData: '{"a":2}' })).not.toBe(recordHash(f));
    expect(recordHash({ ...f, prevHash: '1'.repeat(64) })).not.toBe(recordHash(f));
  });
});
