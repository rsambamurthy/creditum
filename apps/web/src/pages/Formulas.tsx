import { useMemo, useRef, useState } from 'react';
import { api, ApiError, errorMessage, type FormulaExpr, type FormulaRow, type LayoutAdmin, type WriteResult } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { useDebounced } from '../hooks';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ChangeStatus, ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { Badge } from '../components/Badge';
import { DataTable, type Column } from '../components/DataTable';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { FORMULA_SYNTAX, renderFormula, type RenderNames } from '../forms/formulaRender';

interface Placement { module: string; moduleCode: string; section: string; grid: string | null }

function placements(view: LayoutAdmin): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const m of view.document.modules) for (const s of m.sections) {
    for (const f of s.fields) out.set(f.key, { module: m.title, moduleCode: m.code, section: s.title, grid: null });
    for (const f of s.columns ?? []) out.set(f.key, { module: m.title, moduleCode: m.code, section: s.title, grid: s.grid ?? null });
  }
  return out;
}

function tryRender(expr: unknown, names: RenderNames): { text: string } | { error: string } {
  try { return { text: renderFormula(expr, names) }; } catch (e) { return { error: errorMessage(e) }; }
}

function FormulaEditor({ f, view, places, names, canEdit, onClose, onSaved }: {
  f: FormulaRow; view: LayoutAdmin; places: Map<string, Placement>; names: RenderNames; canEdit: boolean; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<'active' | 'pending'>(f.status);
  const [description, setDescription] = useState(f.description ?? '');
  const [note, setNote] = useState(f.note ?? '');
  const [text, setText] = useState(f.expression ? JSON.stringify(f.expression, null, 2) : '');
  const [check, setCheck] = useState<{ ok: true } | { ok: false; message: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const place = places.get(f.fieldKey);

  // Fields the expression may refer to: same grid (with "previous period" for grids) or record level.
  const options = useMemo(() => {
    const same: { key: string; label: string }[] = []; const record: { key: string; label: string }[] = [];
    for (const [key, p] of places) {
      if (key === f.fieldKey || view.fields[key]?.dataType === 'Section Heading') continue;
      const label = view.fields[key]?.label ?? key;
      if (f.grid && p.grid === f.grid) same.push({ key, label });
      else if (!p.grid) record.push({ key, label: `${label} — ${p.section}` });
    }
    same.sort((a, b) => a.label.localeCompare(b.label)); record.sort((a, b) => a.label.localeCompare(b.label));
    return { same, record };
  }, [places, view, f]);

  const parsed = useMemo((): { ok: true; value: FormulaExpr | null } | { ok: false; message: string } => {
    if (!text.trim()) return { ok: true, value: null };
    try { return { ok: true, value: JSON.parse(text) as FormulaExpr }; } catch (e) { return { ok: false, message: `Not valid JSON: ${errorMessage(e)}` }; }
  }, [text]);
  const reading = parsed.ok && parsed.value ? tryRender(parsed.value, names) : null;

  const insert = (snippet: string) => {
    const el = area.current;
    if (!el) { setText(t => t + snippet); return; }
    const s = el.selectionStart; const e = el.selectionEnd;
    const next = text.slice(0, s) + snippet + text.slice(e);
    setText(next); setCheck(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + snippet.length, s + snippet.length); });
  };

  const runCheck = async () => {
    setCheck(null);
    if (!parsed.ok) { setCheck({ ok: false, message: parsed.message }); return; }
    try { await api.checkFormula(f.fieldKey, parsed.value, status); setCheck({ ok: true }); }
    catch (e) { setCheck({ ok: false, message: errorMessage(e) }); }
  };
  const save = async () => {
    if (!parsed.ok) { setCheck({ ok: false, message: parsed.message }); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.saveFormula(f.fieldKey, { status, expression: parsed.value, description: description.trim(), ...(note.trim() ? { note: note.trim() } : {}),
        ...(f.scope === 'tenant' ? { expectedVersion: f.rowVersion } : {}) });
      setResult(r); toast.configResult(r, `Formula for ${f.label} saved`);
      if (r.status === 'applied') onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const revert = async () => {
    if (!window.confirm(`Remove this workspace's formula for "${f.label}" and use the core formula again?`)) return;
    setBusy(true); setError(null); setResult(null);
    try { const r = await api.revertFormula(f.fieldKey); setResult(r); toast.configResult(r, 'Core formula restored'); if (r.status === 'applied') onSaved(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={<>{f.label} <span className="modal-sub">{place ? `${place.section} · ${place.module}` : f.fieldKey}</span></>} onClose={onClose}
      footer={canEdit ? <>
        {f.scope === 'tenant' && <button type="button" className="btn btn-danger-ghost" onClick={revert} disabled={busy}>Revert to core</button>}
        <span className="grow" />
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !description.trim()}>{busy ? 'Saving…' : 'Save formula'}</button>
      </> : <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>}>
      <div className="formula-meta">
        <Badge tone={f.scope === 'core' ? 'info' : 'auto'}>{f.scope === 'core' ? 'Core formula' : 'Workspace formula'}</Badge>
        <span className="icode">{f.fieldKey}</span>
        {f.grid && <span className="muted small">Calculated per row of {f.grid}</span>}
      </div>
      <ChangeStatus result={result} what="The formula" />
      {error instanceof ApiError && error.status === 422 ? <Alert tone="error">{errorMessage(error)}</Alert> : <ErrorAlert error={error} onReload={onSaved} />}
      <div className="form-grid-4" style={{ marginBottom: 14 }}>
        <Field label="Status">
          <select value={status} onChange={e => { setStatus(e.target.value as 'active' | 'pending'); setCheck(null); }} disabled={!canEdit}>
            <option value="active">Active — calculated</option>
            <option value="pending">Pending — waiting for methodology</option>
          </select>
        </Field>
        <Field label="Description" required wide help="Plain language, shown to users next to the calculated value.">
          <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} disabled={!canEdit} />
        </Field>
        <Field label={<>Note <span className="opt">(optional)</span></>} wide>
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} disabled={!canEdit} />
        </Field>
      </div>

      <p className="sub-head">Reads as</p>
      <div className={`formula-reading${reading && 'error' in reading ? ' bad' : ''}`} aria-live="polite">
        {!parsed.ok ? <span className="err-text">{parsed.message}</span>
          : !parsed.value ? <span className="muted">No expression{status === 'pending' ? ' — pending formulas are not calculated' : ''}.</span>
            : reading && 'text' in reading ? <><strong>{f.label}</strong> = {reading.text}</> : <span className="err-text">{reading && 'error' in reading ? reading.error : ''}</span>}
      </div>

      <div className="formula-edit">
        <div>
          <Field label="Expression (JSON)" wide>
            <textarea ref={area} className="json-edit" rows={10} value={text} onChange={e => { setText(e.target.value); setCheck(null); }} spellCheck={false} disabled={!canEdit} />
          </Field>
          {canEdit && (
            <div className="picker-row">
              <label htmlFor="fx-pick" className="sr-only">Field to insert</label>
              <select id="fx-pick" value={pick} onChange={e => setPick(e.target.value)}>
                <option value="">Insert a field…</option>
                {options.same.length > 0 && <optgroup label={`Same grid (${f.grid})`}>{options.same.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</optgroup>}
                <optgroup label="Request record">{options.record.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</optgroup>
              </select>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!pick} onClick={() => insert(JSON.stringify({ f: pick }))}>Insert value</button>
              {f.grid && <button type="button" className="btn btn-secondary btn-sm" disabled={!pick || places.get(pick)?.grid !== f.grid} onClick={() => insert(JSON.stringify({ prev: pick }))}>Insert previous period</button>}
              <span className="grow" />
              <button type="button" className="btn btn-primary btn-sm" onClick={runCheck}>Check</button>
            </div>
          )}
          {check && (check.ok
            ? <p className="check-ok" role="status">✓ The formula is valid for this field.</p>
            : <p className="check-bad" role="alert">✕ {check.message}</p>)}
        </div>
        <details className="syntax-help" open>
          <summary>Syntax</summary>
          <dl>{FORMULA_SYNTAX.map(([k, v]) => <div key={k}><dt className="mono">{k}</dt><dd>{v}</dd></div>)}</dl>
        </details>
      </div>
    </Modal>
  );
}

export function FormulasPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Formulas' }]);
  const { hasRole } = useAuth();
  const canEdit = hasRole('config_admin');
  const list = useApi(() => api.formulas(), []);
  const view = useApi(() => api.layoutAdmin(), []);
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('');
  const [module, setModule] = useState('');
  const [qRaw, setQ] = useState('');
  const q = useDebounced(qRaw.trim().toLowerCase(), 200);
  const [open, setOpen] = useState<FormulaRow | null>(null);

  const places = useMemo(() => (view.data ? placements(view.data) : new Map<string, Placement>()), [view.data]);
  const names = useMemo<RenderNames>(() => {
    const grids = new Map<string, string>();
    for (const m of view.data?.document.modules ?? []) for (const s of m.sections) if (s.grid && !grids.has(s.grid)) grids.set(s.grid, s.title);
    return { field: k => view.data?.fields[k]?.label ?? k, grid: g => grids.get(g) ?? g };
  }, [view.data]);

  const rows = useMemo(() => (list.data ?? []).filter(f =>
    (!status || f.status === status) && (!scope || f.scope === scope) && (!module || places.get(f.fieldKey)?.moduleCode === module) &&
    (!q || [f.label, f.fieldKey, f.description ?? ''].some(v => v.toLowerCase().includes(q)))), [list.data, status, scope, module, q, places]);

  const cols: Column<FormulaRow>[] = [
    { key: 'l', header: 'Field', cell: f => <><div className="strong">{f.label}</div><div className="muted small mono break">{f.fieldKey}</div></> },
    { key: 's', header: 'Section', hideSm: true, cell: f => { const p = places.get(f.fieldKey); return p ? <><div>{p.section}</div><div className="muted small">{p.module}</div></> : '—'; } },
    { key: 'c', header: 'Scope', cell: f => <Badge tone={f.scope === 'core' ? 'info' : 'auto'}>{f.scope === 'core' ? 'Core' : 'Tenant'}</Badge> },
    { key: 't', header: 'Status', cell: f => <Badge tone={f.status === 'active' ? 'ok' : 'warn'}>{f.status === 'active' ? 'Active' : 'Pending'}</Badge> },
    { key: 'd', header: 'Calculation', cell: f => <span className="small">{f.description ?? '—'}</span> },
  ];

  const total = list.data?.length ?? 0;
  const pending = list.data?.filter(f => f.status === 'pending').length ?? 0;
  const tenant = list.data?.filter(f => f.scope === 'tenant').length ?? 0;

  return (
    <div className="page">
      <PageHead title="Formulas" subtitle="How calculated fields are worked out. Core formulas ship with Creditum; a workspace can replace any of them for itself." />
      {list.error ? <ErrorAlert error={list.error} onReload={list.reload} /> : !list.data || !view.data ? <Spinner /> : (
        <>
          <div className="summary-strip" role="group" aria-label="Formula summary">
            <span>Formulas: <strong>{total}</strong></span><span>Active: <strong>{total - pending}</strong></span>
            <span>Pending: <strong>{pending}</strong></span><span>Workspace-specific: <strong>{tenant}</strong></span>
          </div>
          <section className="card">
            <div className="filter-grid filter-grid-4">
              <Field label="Status"><select value={status} onChange={e => setStatus(e.target.value)}><option value="">Any</option><option value="active">Active</option><option value="pending">Pending</option></select></Field>
              <Field label="Scope"><select value={scope} onChange={e => setScope(e.target.value)}><option value="">Core and tenant</option><option value="core">Core</option><option value="tenant">Tenant</option></select></Field>
              <Field label="Module"><select value={module} onChange={e => setModule(e.target.value)}><option value="">All modules</option>{view.data.document.modules.map(m => <option key={m.code} value={m.code}>{m.title}</option>)}</select></Field>
              <Field label="Search"><input type="search" value={qRaw} onChange={e => setQ(e.target.value)} placeholder="Field, key or description…" /></Field>
            </div>
            <DataTable rows={rows} columns={cols} rowKey={f => f.fieldKey} caption="Formulas" onRowClick={setOpen} rowLabel={f => `Open formula for ${f.label}`}
              empty="No formula matches the filters." />
          </section>
        </>
      )}
      {open && view.data && <FormulaEditor key={open.fieldKey} f={open} view={view.data} places={places} names={names} canEdit={canEdit}
        onClose={() => setOpen(null)} onSaved={() => { void list.reload(); }} />}
    </div>
  );
}
