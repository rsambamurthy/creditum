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

const SECTION_CODE = /^[a-z]\.t\.[a-z0-9_]{1,60}$/;
// guardrail-allow: display-title length bound (input sanity), not a business limit
const TITLE_MAX = 160;

/**
 * Check a tenant's layout against the core layout. A tenant may reorder and rename modules and sections,
 * reorder fields, move record-level fields between record sections and add record sections of its own.
 * It may not change where data lives: a field keeps its grid (or record level), sections keep their kind.
 */
export function validateTenantLayout(doc: LayoutDocument, core: LayoutDocument, customKeys: Set<string>): void {
  const bad = (msg: string): never => { throw new FormulaError(msg); };
  if (!doc || !Array.isArray(doc.modules)) bad('The layout needs a list of modules');
  const coreModules = new Map(core.modules.map(m => [m.code, m]));
  const coreSections = new Map(core.modules.flatMap(m => m.sections.map(s => [s.code, { s, module: m.code }] as const)));
  const corePlaced = placements(core);
  const seenModules = new Set<string>();
  for (const m of doc.modules) {
    if (!coreModules.has(m.code)) bad(`Unknown module "${m.code}"`);
    if (seenModules.has(m.code)) bad(`Module "${m.code}" appears twice`);
    seenModules.add(m.code);
    if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > TITLE_MAX) bad(`Module "${m.code}" needs a title of up to ${TITLE_MAX} characters`);
    if (!Array.isArray(m.sections)) bad(`Module "${m.code}" needs a list of sections`);
    for (const s of m.sections) {
      if (typeof s.title !== 'string' || !s.title.trim() || s.title.length > TITLE_MAX) bad(`Section "${s.code}" needs a title of up to ${TITLE_MAX} characters`);
      const c = coreSections.get(s.code);
      if (c) {
        if (c.module !== m.code) bad(`Section "${s.code}" belongs to module "${c.module}"`);
        if (s.kind !== c.s.kind || (s.grid ?? null) !== (c.s.grid ?? null)) bad(`Section "${s.code}" must stay a ${c.s.kind} section`);
      } else {
        if (!SECTION_CODE.test(s.code) || !s.code.startsWith(`${coreModules.get(m.code)!.letter}.t.`)) bad(`New section codes look like "${coreModules.get(m.code)!.letter}.t.my_section"`);
        if (s.kind !== 'record') bad(`New section "${s.code}" must be a record section`);
      }
      if (!Array.isArray(s.fields) || (s.columns !== undefined && !Array.isArray(s.columns))) bad(`Section "${s.code}" has an invalid field list`);
      if (s.kind === 'record' && s.columns?.length) bad(`Record section "${s.code}" cannot have grid columns`);
    }
  }
  const placed = placements({ ...doc, grids: core.grids });
  for (const [key, p] of placed) {
    const c = corePlaced.get(key);
    if (!c) { if (!customKeys.has(key)) bad(`"${key}" is not a field of this form`); if (p.grid !== null) bad(`"${key}" must be a record-level field`); continue; }
    if (c.grid !== p.grid) bad(`"${key}" must stay ${c.grid ? `in grid "${c.grid}"` : 'at record level'}`);
    if ((c.bind ?? null) !== (p.bind ?? null) || (c.list ?? null) !== (p.list ?? null) || (c.display ?? null) !== (p.display ?? null)) bad(`The properties of "${key}" cannot be changed in the layout`);
  }
  const missing = [...corePlaced.keys()].filter(k => !placed.has(k));
  if (missing.length) bad(`The layout leaves out ${missing.length} field(s), e.g. "${missing[0]}" — hide fields through field settings instead`);
}

/**
 * The effective layout: the tenant's arrangement, completed with anything the core layout gained since
 * (new modules, sections, fields) and without fields the core no longer has. Grids always come from the core.
 */
export function mergeLayouts(tenant: LayoutDocument, core: LayoutDocument, customKeys: Set<string>): LayoutDocument {
  const corePlaced = placements(core);
  const keep = (f: LayoutField) => corePlaced.has(f.key) || customKeys.has(f.key);
  const modules = tenant.modules.filter(m => core.modules.some(c => c.code === m.code)).map(m => ({
    ...m, letter: core.modules.find(c => c.code === m.code)!.letter,
    sections: m.sections.map(s => ({ ...s, fields: s.fields.filter(keep).map(f => ({ ...f })), columns: s.columns?.filter(keep).map(f => ({ ...f })) })),
  }));
  for (const cm of core.modules) {
    let tm = modules.find(m => m.code === cm.code);
    if (!tm) { modules.push({ ...cm, sections: [] }); tm = modules[modules.length - 1]; }
    for (const cs of cm.sections) if (!tm.sections.some(s => s.code === cs.code)) tm.sections.push({ ...cs, fields: [], columns: cs.columns ? [] : undefined });
  }
  const doc: LayoutDocument = { ...core, modules };
  const present = new Set(modules.flatMap(m => m.sections.flatMap(s => [...s.fields, ...(s.columns ?? [])].map(f => f.key))));
  for (const cm of core.modules) for (const cs of cm.sections) {
    const target = modules.flatMap(m => m.sections).find(s => s.code === cs.code)!;
    for (const f of cs.fields) if (!present.has(f.key)) target.fields.push({ ...f });
    for (const f of cs.columns ?? []) if (!present.has(f.key)) (target.columns ??= []).push({ ...f });
  }
  return doc;
}
