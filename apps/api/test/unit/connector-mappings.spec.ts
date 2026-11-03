import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridColumns, loadConnectorDefs, resolvePath } from '../../src/modules/integrations/connectors.service';

const layout = JSON.parse(readFileSync(join(__dirname, '..', '..', 'seed', 'core-layout.json'), 'utf8')) as {
  modules: { sections: { grid?: string; fields: { key: string }[]; columns?: { key: string }[] }[] }[] };
const placed = new Map<string, string | null>();
for (const m of layout.modules) for (const s of m.sections) {
  s.fields.forEach(f => placed.set(f.key, null));
  (s.columns ?? []).forEach(f => placed.set(f.key, s.grid ?? null));
}

describe('connector mappings (seed/connectors)', () => {
  const defs = loadConnectorDefs();
  it('has the six bank systems, core banking first', () => {
    expect(defs.map(d => d.connector)).toEqual(['core_banking', 'rating', 'data_warehouse', 'credit_bureau', 'spreading', 'financial_statements']);
  });
  it.each(defs.map(d => [d.connector, d] as const))('%s names only fields on the layout, at the right level', (_, d) => {
    for (const k of Object.keys(d.record)) expect([k, placed.get(k)]).toEqual([k, null]);
    for (const [grid, g] of Object.entries(d.grids)) for (const k of gridColumns(g)) expect([k, placed.get(k)]).toEqual([k, grid]);
    for (const b of Object.values(d.booking ?? {})) {
      for (const k of Object.keys(b.columns)) expect([k, placed.get(k)]).toEqual([k, b.toGrid]);
      expect(placed.get(b.actionField)).toBe(b.fromGrid);
    }
    expect(d.sources[d.required]).toBeDefined();
    if (d.identifier.record) expect(placed.get(d.identifier.record)).toBeNull();
  });
  it('maps each registry taxonomy to the statement lines (Ind AS for MCA, US-GAAP for SEC EDGAR)', () => {
    const fs = defs.find(d => d.connector === 'financial_statements')!;
    const maps = fs.grids['e.financial_periods'].columnsBy!.maps;
    expect(Object.keys(maps)).toEqual(['ind-as', 'us-gaap']);
    expect(maps['ind-as']['e.income_statement.net_sales_revenues']).toBe('RevenueFromOperations');
    expect(maps['us-gaap']['e.income_statement.net_sales_revenues']).toBe('Revenues');
    const sp = defs.find(d => d.connector === 'spreading')!.grids['e.financial_periods'].columnsBy!.maps;
    expect(sp.creditlens['e.income_statement.net_sales_revenues']).toBe('NetSales');
  });
  it('reads nested values and list items by path', () => {
    const doc = { customer: { group: { id: 'G1' } }, packages: [{ items: [{ v: '2' }] }] };
    expect(resolvePath(doc, 'customer.group.id')).toBe('G1');
    expect(resolvePath(doc, 'packages[0].items[0].v')).toBe('2');
    expect(resolvePath(doc, 'packages[1].items')).toBeUndefined();
    expect(resolvePath(doc, 'customer.missing.deeper')).toBeUndefined();
  });
});
