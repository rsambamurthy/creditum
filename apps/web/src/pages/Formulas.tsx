import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage, type FormulaExpr, type FormulaPreview, type FormulaRow, type LayoutAdmin, type WriteResult } from '../api';
import { formatDecimal } from '../format';
import { FormulaBar, type BarField, type BarSetting } from '../forms/FormulaBar';
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

interface Support { functions: string[]; settings: BarSetting[] }

const DISPLAY_ONLY = new Set(['Section Heading', 'Chart (derived)', 'Table (derived)']);

/** Fields offered by the formula bar, with the exact text the server accepts ([Label] or [Section › Label]). */
function barFields(view: LayoutAdmin, places: Map<string, Placement>, f: FormulaRow): BarField[] {
  const counts = new Map<string, number>();
  for (const [key] of places) { const l = view.fields[key]?.label ?? key; counts.set(l.toLowerCase(), (counts.get(l.toLowerCase()) ?? 0) + 1); }
  const out: BarField[] = [];
  for (const [key, p] of places) {
    const meta = view.fields[key];
    if (key === f.fieldKey || !meta || DISPLAY_ONLY.has(meta.dataType)) continue;
    const label = meta.label;
    const repeated = (counts.get(label.toLowerCase()) ?? 0) > 1;
    const scope: BarField['scope'] = f.grid && p.grid === f.grid ? 'same' : !p.grid ? 'record' : 'other';
    if (f.grid && scope === 'other') continue; // a table formula reads its own row and the record
    out.push({ key, label, section: p.section, scope, insert: repeated ? `[${p.section} › ${label}]` : `[${label}]` });
  }
  return out;
}

const atChar = (message: string): number | null => { const m = /\(at character (\d+)\)/.exec(message); return m ? Number(m[1]) - 1 : null; };

function TryIt({ f, text, valid }: { f: FormulaRow; text: string; valid: boolean }) {
  const requests = useApi(() => api.listRequests(), []);
  const [requestId, setRequestId] = useState('');
  const [result, setResult] = useState<FormulaPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const noList = requests.error instanceof ApiError && requests.error.status === 403;
  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await api.previewFormula(f.fieldKey, text, requestId.trim())); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="try-it">
      <p className="sub-head">Try it on a request</p>
      <div className="picker-row">
        {requests.data && requests.data.length > 0 ? (
          <select aria-label="Credit request" value={requestId} onChange={e => { setRequestId(e.target.value); setResult(null); }}>
            <option value="">Choose a recent request…</option>
            {requests.data.slice(0, 30).map(r => <option key={r.id} value={r.id}>{r.requestNumber} · {r.borrowerName}</option>)}
          </select>
        ) : (
          <input aria-label="Request ID" placeholder="Paste the request ID (from the request page address)" value={requestId} onChange={e => { setRequestId(e.target.value); setResult(null); }} className="mono" />
        )}
        <button type="button" className="btn btn-secondary btn-sm" disabled={!valid || !requestId.trim() || busy} onClick={run}>{busy ? 'Calculating…' : 'Calculate'}</button>
      </div>
      {noList && <p className="field-help">Your role cannot list credit requests, so paste a request ID: open the request and copy the last part of the page address.</p>}
      {requests.data && requests.data.length === 0 && <p className="field-help">No credit requests yet — the preview needs a saved request.</p>}
      <ErrorAlert error={error} />
      {result && ('rows' in result ? (
        result.rows.length === 0 ? <p className="muted small">This request has no rows in the table yet.</p> : (
          <table className="table static compact preview-table">
            <caption className="sr-only">Calculated value per row</caption>
            <thead><tr><th scope="col">Row</th><th scope="col" className="num">{f.label}</th></tr></thead>
            <tbody>{result.rows.map(r => <tr key={r.rowKey}><td>{r.label}</td><td className="num mono-num">{r.value === null ? <span className="muted">empty</span> : formatDecimal(r.value)}</td></tr>)}</tbody>
          </table>
        )
      ) : <p className="preview-value">{f.label} = <strong className="mono-num">{result.value === null ? 'empty' : formatDecimal(result.value)}</strong> <span className="muted small">(not saved)</span></p>)}
    </div>
  );
}

function FormulaEditor({ f, view, places, names, support, canEdit, onClose, onSaved }: {
  f: FormulaRow; view: LayoutAdmin; places: Map<string, Placement>; names: RenderNames; support: Support; canEdit: boolean; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<'active' | 'pending'>(f.status);
  const [description, setDescription] = useState(f.description ?? '');
  const [note, setNote] = useState(f.note ?? '');
  const [text, setText] = useState(f.text ?? '');
  const [parsed, setParsed] = useState<{ ok: true; expression: FormulaExpr; text: string } | { ok: false; message: string } | null>(null);
  const [check, setCheck] = useState<{ ok: true } | { ok: false; message: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const place = places.get(f.fieldKey);
  const fields = useMemo(() => barFields(view, places, f), [view, places, f]);
  const debounced = useDebounced(text, 400);

  useEffect(() => {
    let live = true;
    setCheck(null);
    if (!debounced.trim()) { setParsed(null); return; }
    api.parseFormula(f.fieldKey, debounced)
      .then(r => { if (live) setParsed({ ok: true, expression: r.expression, text: r.text }); })
      .catch(e => { if (live) setParsed({ ok: false, message: errorMessage(e) }); });
    return () => { live = false; };
  }, [debounced, f.fieldKey]);

  const pendingParse = text !== debounced;
  const valid = !!parsed && parsed.ok && !pendingParse;
  const reading = parsed && parsed.ok ? (() => { try { return renderFormula(parsed.expression, names); } catch { return null; } })() : null;
  const errorAt = parsed && !parsed.ok && !pendingParse ? atChar(parsed.message) : null;

  const runCheck = async () => {
    setCheck(null);
    if (!parsed || !parsed.ok) return;
    try { await api.checkFormula(f.fieldKey, parsed.expression, status); setCheck({ ok: true }); } catch (e) { setCheck({ ok: false, message: errorMessage(e) }); }
  };
  const save = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.saveFormula(f.fieldKey, { status, description: description.trim(), ...(note.trim() ? { note: note.trim() } : {}),
        ...(text.trim() ? { text: text.trim() } : { expression: null }), ...(f.scope === 'tenant' ? { expectedVersion: f.rowVersion } : {}) });
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
  const missingText = status === 'active' && !text.trim();

  return (
    <Modal wide title={<>{f.label} <span className="modal-sub">{place ? `${place.section} · ${place.module}` : f.fieldKey}</span></>} onClose={onClose}
      footer={canEdit ? <>
        {f.scope === 'tenant' && <button type="button" className="btn btn-danger-ghost" onClick={revert} disabled={busy}>Revert to core</button>}
        <span className="grow" />
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !description.trim() || missingText || (!!text.trim() && !valid)}>{busy ? 'Saving…' : 'Save formula'}</button>
      </> : <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>}>
      <div className="formula-meta">
        <Badge tone={f.scope === 'core' ? 'info' : 'auto'}>{f.scope === 'core' ? 'Core formula' : 'Workspace formula'}</Badge>
        {f.grid ? <span className="muted small">Calculated for every row of “{place?.section ?? f.grid}”</span> : <span className="muted small">Calculated once per request</span>}
      </div>
      <ChangeStatus result={result} what="The formula" />
      {error instanceof ApiError && error.status === 422 ? <Alert tone="error">{errorMessage(error)}</Alert> : <ErrorAlert error={error} onReload={onSaved} />}

      <label className="field-label" htmlFor="fx-text">{f.label} =</label>
      <FormulaBar id="fx-text" value={text} onChange={v => { setText(v); setCheck(null); }} fields={fields} functions={support.functions} settings={support.settings}
        disabled={!canEdit} errorAt={errorAt} describedBy="fx-status" />
      <div id="fx-status" className="fx-status" aria-live="polite">
        {!text.trim() ? <span className="muted">{status === 'pending' ? 'No formula yet — the field shows “No formula yet”.' : 'Write the formula, e.g. PERCENT([Gross Profit], [Revenue / Sales]).'}</span>
          : pendingParse || !parsed ? <span className="muted">Checking…</span>
            : parsed.ok ? <>
              <span className="check-ok">✓ Understood</span>
              {parsed.text !== text.trim() && <span className="muted small"> as <span className="mono">{parsed.text}</span> <button type="button" className="link-btn small" onClick={() => setText(parsed.text)} disabled={!canEdit}>Use this</button></span>}
              {reading && <div className="formula-reading"><strong>Reads as:</strong> {f.label} = {reading}</div>}
            </> : <span className="check-bad">✕ {parsed.message}</span>}
      </div>

      <div className="form-grid-4" style={{ margin: '16px 0' }}>
        <Field label="Status">
          <select value={status} onChange={e => { setStatus(e.target.value as 'active' | 'pending'); setCheck(null); }} disabled={!canEdit}>
            <option value="active">Active — calculated</option>
            <option value="pending">Pending — waiting for the bank’s method</option>
          </select>
        </Field>
        <Field label="Description" required wide help="Plain language, shown to users next to the calculated value.">
          <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} disabled={!canEdit} />
        </Field>
        <Field label={<>Note <span className="opt">(optional)</span></>} wide>
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} disabled={!canEdit} />
        </Field>
      </div>

      {canEdit && (
        <div className="picker-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={runCheck} disabled={!valid}>Check against all formulas</button>
          {check && (check.ok ? <span className="check-ok" role="status">✓ No problems — no circular references, every field and setting exists.</span> : <span className="check-bad" role="alert">✕ {check.message}</span>)}
        </div>
      )}
      {canEdit && <TryIt f={f} text={text.trim()} valid={valid} />}

      <details className="syntax-help" style={{ marginTop: 16 }}>
        <summary>How to write formulas</summary>
        <ul className="help-list">
          <li><span className="mono">[Field label]</span> — a field; write <span className="mono">[Section › Field]</span> when two fields share a label.</li>
          <li><span className="mono">+ − × ÷</span> (or <span className="mono">+ - * /</span>), brackets and numbers work as in a spreadsheet.</li>
          {support.functions.map(fn => <li key={fn}><span className="mono">{fn.split(' — ')[0]}</span>{fn.includes(' — ') ? ` — ${fn.split(' — ')[1]}` : ''}</li>)}
          <li>Example: <span className="mono">PERCENT([Gross Profit], [Revenue / Sales])</span> · <span className="mono">GROWTH([Revenue / Sales], PREVIOUS([Revenue / Sales]))</span></li>
        </ul>
      </details>
      <details className="advanced">
        <summary>Advanced (developers)</summary>
        <p className="muted small">The stored expression generated from the text (read-only).</p>
        <pre className="code light">{parsed && parsed.ok ? JSON.stringify(parsed.expression, null, 2) : f.expression ? JSON.stringify(f.expression, null, 2) : '—'}</pre>
        <p className="muted small">{FORMULA_SYNTAX.length} operators: {FORMULA_SYNTAX.map(([k]) => k.split('"')[1]).join(', ')}.</p>
      </details>
    </Modal>
  );
}

export function FormulasPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Formulas' }]);
  const { hasRole } = useAuth();
  const canEdit = hasRole('config_admin');
  const list = useApi(() => api.formulas(), []);
  const view = useApi(() => api.layoutAdmin(), []);
  const support = useApi(async (): Promise<Support> => {
    const [functions, catalog] = await Promise.all([api.formulaFunctions(), api.rulesCatalog().catch(() => null)]);
    const settings = (catalog?.parameters ?? []).filter(p => p.valueType === 'decimal' || p.valueType === 'integer').map(p => ({ key: p.key, description: p.description, value: p.value }));
    return { functions, settings };
  }, []);
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
    (!q || [f.label, f.fieldKey, f.description ?? '', f.text ?? ''].some(v => v.toLowerCase().includes(q)))), [list.data, status, scope, module, q, places]);

  const cols: Column<FormulaRow>[] = [
    { key: 'l', header: 'Field', cell: f => <><div className="strong">{f.label}</div><div className="muted small mono break">{f.fieldKey}</div></> },
    { key: 's', header: 'Section', hideSm: true, cell: f => { const p = places.get(f.fieldKey); return p ? <><div>{p.section}</div><div className="muted small">{p.module}</div></> : '—'; } },
    { key: 'c', header: 'Scope', cell: f => <Badge tone={f.scope === 'core' ? 'info' : 'auto'}>{f.scope === 'core' ? 'Core' : 'Tenant'}</Badge> },
    { key: 't', header: 'Status', cell: f => <Badge tone={f.status === 'active' ? 'ok' : 'warn'}>{f.status === 'active' ? 'Active' : 'Pending'}</Badge> },
    { key: 'd', header: 'Calculation', cell: f => <>{f.text ? <div className="mono small formula-text">{f.text}</div> : <div className="muted small">No formula yet</div>}<div className="muted small">{f.description ?? ''}</div></> },
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
      {open && view.data && <FormulaEditor key={open.fieldKey} f={open} view={view.data} places={places} names={names} support={support.data ?? { functions: [], settings: [] }} canEdit={canEdit}
        onClose={() => setOpen(null)} onSaved={() => { void list.reload(); }} />}
    </div>
  );
}
