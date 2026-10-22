/**
 * Credit Request screen layout (configuration data, SDD Section 20): modules → sections → fields.
 * A section is either a record section (one value per field), a grid (rows of values) or a period grid
 * (financial periods: line items down, periods across). Pure helpers only — no I/O.
 */
import { FormulaError } from './formula-engine';

export interface LayoutField { key: string; list?: string; bind?: 'borrowerName' | 'borrowerRef'; display?: 'chart' | 'table' | 'heading' }
export interface LayoutSection {
  code: string; title: string; kind: 'record' | 'grid' | 'periods';
  grid?: string; rowLabel?: string; fields: LayoutField[]; columns?: LayoutField[];
}
export interface LayoutModule { code: string; letter: string; title: string; sections: LayoutSection[] }
export interface LayoutDocument {
  layout: string; version: number;
  grids: Record<string, { rowLabel: string; ordered: boolean; labelField?: string }>;
  modules: LayoutModule[];
}

export interface PlacedField extends LayoutField { module: string; section: string; sectionTitle: string; grid: string | null }

/** Every field on the form with where it lives (grid code, or null for record level). */
export function placements(doc: LayoutDocument): Map<string, PlacedField> {
  const out = new Map<string, PlacedField>();
  for (const m of doc.modules) {
    for (const s of m.sections) {
      const put = (f: LayoutField, grid: string | null) => {
        if (out.has(f.key)) throw new FormulaError(`Field "${f.key}" is placed twice in the layout`);
        out.set(f.key, { ...f, module: m.code, section: s.code, sectionTitle: s.title, grid });
      };
      s.fields.forEach(f => put(f, null));
      if (s.kind !== 'record') {
        if (!s.grid || !doc.grids[s.grid]) throw new FormulaError(`Section "${s.code}" refers to an undeclared grid`);
        (s.columns ?? []).forEach(f => put(f, s.grid as string));
      }
    }
  }
  return out;
}

/** Composite data types: one field stored as several typed parts (key + ':' + part). */
export const COMPOSITE_PARTS: Record<string, string[]> = {
  'Tier Bracket (from / to amount + rate)': ['from', 'to', 'rate'],
};

/** Data types that display derived content only and hold no value. */
export const DISPLAY_ONLY_TYPES = new Set(['Chart (derived)', 'Table (derived)', 'Section Heading']);
