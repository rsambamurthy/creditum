/**
 * Renders one layout section generically by its kind: record (form grid), grid (rows of values) or
 * periods (financial matrix: line items down, periods across — the period grid is shared by sections).
 */
import { useState, type ReactNode } from 'react';
import type { FieldMeta, FormValue, Layout, SectionMeta } from '../api';
import { Modal } from '../components/Modal';
import { FieldInput, formatFieldDecimal, type Header } from './FieldInput';
import { newRowId, type LocalRow } from './formState';

export interface FormCtx {
  layout: Layout;
  record: Record<string, FormValue>;
  grids: Record<string, LocalRow[]>;
  setRecord: (key: string, v: FormValue) => void;
  setGrid: (grid: string, rows: LocalRow[]) => void;
  header: Header;
  disabled: boolean;
  /** Missing mandatory values: "key" (record) or "key@rowKey" (grid cell). */
  missing: Set<string>;
}

/** Columns shown in a grid table before switching to a row-card editor. */
const INLINE_MAX_COLUMNS = 6;
const TABLE_PREVIEW_COLUMNS = 5;

export const fieldDomId = (key: string, rowKey?: string | null) => `fld-${key}${rowKey ? `-${rowKey}` : ''}`.replace(/[^A-Za-z0-9_-]/g, '_');
export const sectionDomId = (code: string) => `sec-${code}`.replace(/[^A-Za-z0-9_-]/g, '_');

function RecordFields({ fields, ctx }: { fields: FieldMeta[]; ctx: FormCtx }) {
  if (!fields.length) return null;
  return (
    <div className="form-2col">
      {fields.map(f => (
        <FieldInput key={f.key} meta={f} values={ctx.record} onChange={ctx.setRecord} layout={ctx.layout} header={ctx.header}
          disabled={ctx.disabled} domId={fieldDomId(f.key)} missing={ctx.missing.has(f.key)} />
      ))}
    </div>
  );
}

function move<T>(xs: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= xs.length) return xs;
  const out = [...xs]; [out[i], out[j]] = [out[j], out[i]]; return out;
}

function RowEditor({ section, row, index, ctx, onApply, onClose }: {
  section: SectionMeta; row: LocalRow; index: number; ctx: FormCtx; onApply: (r: LocalRow) => void; onClose: () => void;
}) {
  const [values, setValues] = useState(row.values);
  const label = section.rowLabel ?? 'Row';
  return (
    <Modal wide title={`${label} ${index + 1} · ${section.title}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-secondary" onClick={onClose}>{ctx.disabled ? 'Close' : 'Cancel'}</button>
      {!ctx.disabled && <button type="button" className="btn btn-primary" onClick={() => onApply({ ...row, values })}>Apply</button>}
    </>}>
      <div className="form-2col">
        {(section.columns ?? []).map(c => (
          <FieldInput key={c.key} meta={c} values={values} onChange={(k, v) => setValues(x => ({ ...x, [k]: v }))} layout={ctx.layout}
            header={ctx.header} disabled={ctx.disabled} missing={!!row.rowKey && ctx.missing.has(`${c.key}@${row.rowKey}`)} />
        ))}
      </div>
      {!ctx.disabled && <p className="muted small" style={{ margin: '14px 0 0' }}>Apply keeps the change on screen; use Save to store it.</p>}
    </Modal>
  );
}

function GridSection({ section, ctx }: { section: SectionMeta; ctx: FormCtx }) {
  const grid = section.grid!;
  const rows = ctx.grids[grid] ?? [];
  const cols = (section.columns ?? []).filter(c => c.display !== 'heading');
  const inline = cols.length <= INLINE_MAX_COLUMNS;
  const shown = inline ? cols : cols.slice(0, TABLE_PREVIEW_COLUMNS);
  const label = section.rowLabel ?? ctx.layout.grids[grid]?.rowLabel ?? 'Row';
  const [editing, setEditing] = useState<number | null>(null);

  const setRows = (r: LocalRow[]) => ctx.setGrid(grid, r);
  const setCell = (i: number, k: string, v: FormValue) => setRows(rows.map((r, j) => (j === i ? { ...r, values: { ...r.values, [k]: v } } : r)));
  const add = () => {
    const next = [...rows, { id: newRowId(), values: {} }];
    setRows(next);
    if (!inline) setEditing(next.length - 1);
  };
  const rowMissing = (r: LocalRow) => !!r.rowKey && cols.some(c => ctx.missing.has(`${c.key}@${r.rowKey}`));

  return (
    <>
      <RecordFields fields={section.fields} ctx={ctx} />
      <div className="grid-box">
        <div className="table-wrap">
          <table className="table static compact grid-table">
            <caption className="sr-only">{section.title}</caption>
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                {shown.map(c => <th scope="col" key={c.key} className={c.valueKind === 'decimal' ? 'num' : undefined}>{c.label}{c.requirement === 'Mandatory' && <span className="req" aria-hidden="true"> *</span>}</th>)}
                {!inline && <th scope="col" className="muted">{cols.length - shown.length} more</th>}
                <th scope="col"><span className="sr-only">Row actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr className="no-hover"><td colSpan={shown.length + (inline ? 2 : 3)}><div className="empty small" style={{ padding: 18 }}>No {label.toLowerCase()} rows yet.</div></td></tr>}
              {rows.map((r, i) => (
                <tr key={r.id} id={r.rowKey ? `row-${fieldDomId(section.code, r.rowKey)}` : undefined} className={rowMissing(r) ? 'has-issue' : undefined}>
                  <td className="num muted">{i + 1}</td>
                  {shown.map(c => (
                    <td key={c.key} className={c.valueKind === 'decimal' ? 'num' : undefined}>
                      {inline ? (
                        <FieldInput cell meta={c} values={r.values} onChange={(k, v) => setCell(i, k, v)} layout={ctx.layout} header={ctx.header}
                          disabled={ctx.disabled} cellLabel={`${c.label}, ${label} ${i + 1}`} domId={r.rowKey ? fieldDomId(c.key, r.rowKey) : undefined}
                          missing={!!r.rowKey && ctx.missing.has(`${c.key}@${r.rowKey}`)} />
                      ) : <CellText meta={c} v={r.values[c.key]} ctx={ctx} />}
                    </td>
                  ))}
                  {!inline && <td>{rowMissing(r) && <span className="badge badge-warn sm">Missing values</span>}</td>}
                  <td className="actions">
                    <div className="row-tools">
                      {!inline && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(i)} aria-label={`${ctx.disabled ? 'View' : 'Edit'} ${label} ${i + 1}`}>{ctx.disabled ? 'View' : 'Edit'}</button>}
                      {!ctx.disabled && <>
                        <button type="button" className="icon-btn" onClick={() => setRows(move(rows, i, -1))} disabled={i === 0} aria-label={`Move ${label} ${i + 1} up`}>↑</button>
                        <button type="button" className="icon-btn" onClick={() => setRows(move(rows, i, 1))} disabled={i === rows.length - 1} aria-label={`Move ${label} ${i + 1} down`}>↓</button>
                        <button type="button" className="icon-btn danger" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${label} ${i + 1}`}>✕</button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ctx.disabled && <div className="grid-foot"><button type="button" className="btn btn-secondary btn-sm" onClick={add}>+ Add {label.toLowerCase()}</button></div>}
      </div>
      {editing !== null && rows[editing] && (
        <RowEditor section={section} row={rows[editing]} index={editing} ctx={ctx} onClose={() => setEditing(null)}
          onApply={r => { setRows(rows.map((x, j) => (j === editing ? r : x))); setEditing(null); }} />
      )}
    </>
  );
}

function CellText({ meta, v, ctx }: { meta: FieldMeta; v: FormValue | undefined; ctx: FormCtx }): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (meta.list) return ctx.layout.lists[meta.list]?.find(e => e.code === v)?.label ?? v;
  if (meta.valueKind === 'decimal') {
    const d = formatFieldDecimal(meta, v, ctx.layout);
    return <span className="mono-num" title={d.full ? `Stored value: ${d.full}` : undefined}>{d.text}</span>;
  }
  return v;
}

/**
 * Display name of a period column: the value of the grid's label field (e.g. the statement date) when configured
 * and filled; otherwise its row label and position, with the first date it carries.
 */
function periodName(row: LocalRow, i: number, rowLabel: string, labelField?: string): string {
  const named = labelField ? row.values[labelField] : undefined;
  if (typeof named === 'string' && named.trim()) return named.trim();
  const date = Object.values(row.values).find(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) as string | undefined;
  return date ? `${rowLabel} ${i + 1} · ${date}` : `${rowLabel} ${i + 1}`;
}

function PeriodsSection({ section, ctx }: { section: SectionMeta; ctx: FormCtx }) {
  const grid = section.grid!;
  const periods = ctx.grids[grid] ?? [];
  const label = section.rowLabel ?? ctx.layout.grids[grid]?.rowLabel ?? 'Period';
  const setRows = (r: LocalRow[]) => ctx.setGrid(grid, r);
  const setCell = (i: number, k: string, v: FormValue) => setRows(periods.map((r, j) => (j === i ? { ...r, values: { ...r.values, [k]: v } } : r)));
  const cols = section.columns ?? [];
  const labelField = ctx.layout.grids[grid]?.labelField;
  const name = (p: LocalRow, i: number) => periodName(p, i, label, labelField);

  return (
    <>
      <RecordFields fields={section.fields} ctx={ctx} />
      <div className="grid-box">
        <div className="table-wrap matrix-wrap">
          <table className="table static compact matrix">
            <caption className="sr-only">{section.title} — line items down, {label.toLowerCase()}s across</caption>
            <thead>
              <tr>
                <th scope="col" className="matrix-item">Line item</th>
                {periods.map((p, i) => (
                  <th scope="col" key={p.id} className="num matrix-period">
                    <div className="period-head">
                      <span>{name(p, i)}</span>{name(p, i) !== `${label} ${i + 1}` && <span className="muted small">{label} {i + 1}</span>}
                      {!ctx.disabled && (
                        <span className="row-tools">
                          <button type="button" className="icon-btn" onClick={() => setRows(move(periods, i, -1))} disabled={i === 0} aria-label={`Move ${label} ${i + 1} earlier`}><span className="rtl-flip">←</span></button>
                          <button type="button" className="icon-btn" onClick={() => setRows(move(periods, i, 1))} disabled={i === periods.length - 1} aria-label={`Move ${label} ${i + 1} later`}><span className="rtl-flip">→</span></button>
                          <button type="button" className="icon-btn danger" onClick={() => setRows(periods.filter((_, j) => j !== i))} aria-label={`Remove ${label} ${i + 1}`}>✕</button>
                        </span>
                      )}
                    </div>
                  </th>
                ))}
                {periods.length === 0 && <th scope="col" className="muted">No {label.toLowerCase()}s yet</th>}
              </tr>
            </thead>
            <tbody>
              {cols.map(c => c.display === 'heading' ? (
                <tr key={c.key} className="matrix-heading"><th scope="rowgroup" colSpan={Math.max(periods.length, 1) + 1}>{c.label}</th></tr>
              ) : (
                <tr key={c.key}>
                  <th scope="row" className="matrix-item">
                    {c.label}{c.requirement === 'Mandatory' && !c.readOnly && <span className="req" aria-hidden="true"> *</span>}
                    {c.calc && <span className={`calc-tag${c.calc.status === 'pending' ? ' pending' : ''}`} title={[c.calc.description, c.calc.note].filter(Boolean).join(' — ')}>{c.calc.status === 'pending' ? 'Pending formula' : 'Calc'}</span>}
                  </th>
                  {periods.map((p, i) => (
                    <td key={p.id} className="num">
                      <FieldInput cell meta={c} values={p.values} onChange={(k, v) => setCell(i, k, v)} layout={ctx.layout} header={ctx.header}
                        disabled={ctx.disabled} cellLabel={`${c.label}, ${label} ${i + 1}`} domId={p.rowKey ? fieldDomId(c.key, p.rowKey) : undefined}
                        missing={!!p.rowKey && ctx.missing.has(`${c.key}@${p.rowKey}`)} />
                    </td>
                  ))}
                  {periods.length === 0 && <td />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ctx.disabled && (
          <div className="grid-foot">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows([...periods, { id: newRowId(), values: {} }])}>+ Add {label.toLowerCase()}</button>
            <span className="muted small">{ctx.layout.grids[grid]?.ordered ? `Oldest ${label.toLowerCase()} first. ` : ''}{label}s are shared by all financial statements of this request.</span>
          </div>
        )}
      </div>
    </>
  );
}

export function SectionRenderer({ section, ctx }: { section: SectionMeta; ctx: FormCtx }) {
  return (
    <fieldset className="group form-section" id={sectionDomId(section.code)}>
      <legend><span className="grow">{section.title}</span>{section.kind !== 'record' && <span className="badge badge-neutral sm">{section.kind === 'periods' ? 'By period' : `${(ctx.grids[section.grid!] ?? []).length} ${(section.rowLabel ?? 'row').toLowerCase()}${(ctx.grids[section.grid!] ?? []).length === 1 ? '' : 's'}`}</span>}</legend>
      {section.kind === 'record' && <RecordFields fields={section.fields} ctx={ctx} />}
      {section.kind === 'grid' && <GridSection section={section} ctx={ctx} />}
      {section.kind === 'periods' && <PeriodsSection section={section} ctx={ctx} />}
    </fieldset>
  );
}
