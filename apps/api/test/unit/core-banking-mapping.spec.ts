import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMapping, resolvePath } from '../../src/modules/integrations/core-banking.service';

const layout = JSON.parse(readFileSync(join(__dirname, '..', '..', 'seed', 'core-layout.json'), 'utf8')) as {
  modules: { sections: { grid?: string; fields: { key: string }[]; columns?: { key: string }[] }[] }[] };
const placed = new Map<string, string | null>();
for (const m of layout.modules) for (const s of m.sections) {
  s.fields.forEach(f => placed.set(f.key, null));
  (s.columns ?? []).forEach(f => placed.set(f.key, s.grid ?? null));
}

describe('core banking mapping (seed/connectors/core-banking.json)', () => {
  const map = loadMapping();
  it('names only fields that exist on the layout, at the right level', () => {
    for (const k of Object.keys(map.record)) expect([k, placed.get(k)]).toEqual([k, null]);
    for (const [grid, g] of Object.entries(map.grids)) for (const k of Object.keys(g.columns)) expect([k, placed.get(k)]).toEqual([k, grid]);
    for (const b of Object.values(map.booking)) {
      for (const k of Object.keys(b.columns)) expect([k, placed.get(k)]).toEqual([k, b.toGrid]);
      expect(placed.get(b.actionField)).toBe(b.fromGrid);
    }
  });
  it('reads nested values and list items by path', () => {
    const doc = { customer: { group: { id: 'G1' } }, packages: [{ items: [{ v: '2' }] }] };
    expect(resolvePath(doc, 'customer.group.id')).toBe('G1');
    expect(resolvePath(doc, 'packages[0].items[0].v')).toBe('2');
    expect(resolvePath(doc, 'packages[1].items')).toBeUndefined();
    expect(resolvePath(doc, 'customer.missing.deeper')).toBeUndefined();
  });
});
