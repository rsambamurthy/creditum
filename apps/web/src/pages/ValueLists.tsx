import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage, type ValueListAdminEntry, type WriteResult } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { useReference } from '../reference';
import { humanize } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ChangeStatus, ErrorAlert, Loadable, PageHead, Spinner } from '../components/Feedback';
import { Badge } from '../components/Badge';
import { useToast } from '../components/Toast';

/** An entry on screen. `isNew` rows have an editable code until saved. */
interface Row { id: string; code: string; label: string; active: boolean; isNew: boolean }

const CODE = /^[A-Za-z0-9_.-]+$/;
let seq = 0;

function toRows(entries: ValueListAdminEntry[]): Row[] {
  const active = entries.filter(e => e.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  const retired = entries.filter(e => !e.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  return [...active, ...retired].map(e => ({ id: e.id, code: e.code, label: e.label, active: e.isActive, isNew: false }));
}

function ListEditor({ listKey, usedBy, canEdit }: { listKey: string; usedBy: string[]; canEdit: boolean }) {
  const toast = useToast();
  const state = useApi(() => api.valueListEntries(listKey), [listKey]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [orig, setOrig] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.data) { const r = toRows(state.data); setRows(r); setOrig(JSON.stringify(r)); setError(null); }
  }, [state.data]);
  useEffect(() => { setResult(null); }, [listKey]);

  if (state.error) return <ErrorAlert error={state.error} onReload={state.reload} />;
  if (!rows) return <Spinner />;

  const active = rows.filter(r => r.active);
  const retired = rows.filter(r => !r.active);
  const dirty = JSON.stringify(rows) !== orig;
  const codes = rows.map(r => r.code.trim());
  const rowError = (r: Row): string | null => {
    if (!r.label.trim()) return 'Enter a label';
    if (r.isNew) {
      if (!r.code.trim()) return 'Enter a code';
      if (!CODE.test(r.code.trim())) return 'Letters, digits, "_", "-" and "." only';
      if (codes.filter(c => c === r.code.trim()).length > 1) return 'This code is already in the list';
    }
    return null;
  };
  const invalid = rows.some(r => rowError(r));

  const update = (id: string, patch: Partial<Row>) => setRows(rows.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const move = (id: string, d: number) => {
    const i = active.findIndex(r => r.id === id); const j = i + d;
    if (j < 0 || j >= active.length) return;
    const next = [...active]; [next[i], next[j]] = [next[j], next[i]];
    setRows([...next, ...retired]);
  };
  const setActive = (r: Row, on: boolean) => {
    if (!on && r.isNew) { setRows(rows.filter(x => x.id !== r.id)); return; }
    // Reactivated entries join the end of the active list; retired ones the top of the retired list.
    const others = rows.filter(x => x.id !== r.id);
    setRows([...others.filter(x => x.active), { ...r, active: on }, ...others.filter(x => !x.active)]);
  };
  const add = () => setRows([...active, { id: `new-${++seq}`, code: '', label: '', active: true, isNew: true }, ...retired]);

  const save = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.saveValueList(listKey, rows.map(x => ({ code: x.code.trim(), label: x.label.trim(), active: x.active })));
      setResult(r);
      toast.configResult(r, `${humanize(listKey)} updated`);
      if (r.status === 'applied') await state.reload(); else setOrig(JSON.stringify(rows));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const renderRow = (r: Row, i: number, list: Row[]) => {
    const err = rowError(r);
    return (
      <tr key={r.id} className={r.active ? undefined : 'retired'}>
        <td className="num muted">{r.active ? i + 1 : ''}</td>
        <td>
          {r.isNew && canEdit
            ? <input aria-label={`Code for new entry ${i + 1}`} className="mono" value={r.code} onChange={e => update(r.id, { code: e.target.value })} placeholder="new_code" />
            : <span className="icode">{r.code}</span>}
        </td>
        <td>
          {canEdit && r.active
            ? <input aria-label={`Label for ${r.code || 'new entry'}`} value={r.label} onChange={e => update(r.id, { label: e.target.value })} maxLength={250} />
            : r.label}
          {err && canEdit && r.active && <div className="field-error">{err}</div>}
        </td>
        <td>
          {canEdit ? (
            r.active
              ? <label className="switch"><input type="checkbox" checked onChange={() => setActive(r, false)} aria-label={`${r.label || r.code} is active — retire`} /><span>Active</span></label>
              : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setActive(r, true)}>Reactivate</button>
          ) : r.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Retired</Badge>}
        </td>
        <td className="actions">
          {canEdit && r.active && (
            <span className="row-tools">
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(r.id, -1)} aria-label={`Move ${r.label || 'entry'} up`}>↑</button>
              <button type="button" className="icon-btn" disabled={i === list.length - 1} onClick={() => move(r.id, 1)} aria-label={`Move ${r.label || 'entry'} down`}>↓</button>
            </span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <section className="card" aria-labelledby="vl-head">
      <div className="card-head">
        <h3 id="vl-head">{humanize(listKey)} <span className="icode">{listKey}</span></h3>
        <span className="muted small">{active.length} active{retired.length ? ` · ${retired.length} retired` : ''}</span>
      </div>
      <div className="card-body">
        {usedBy.length > 0
          ? <p className="muted small" style={{ marginTop: 0 }}>Used by {usedBy.length} field{usedBy.length === 1 ? '' : 's'}: {usedBy.slice(0, 6).join(', ')}{usedBy.length > 6 ? ` and ${usedBy.length - 6} more` : ''}.</p>
          : <p className="muted small" style={{ marginTop: 0 }}>Not used by a field on the Credit Request screens.</p>}
        <ChangeStatus result={result} what="The list change" />
        {error instanceof ApiError && error.status === 422 ? <Alert tone="error">{errorMessage(error)}</Alert> : <ErrorAlert error={error} onReload={state.reload} />}
        <div className="table-wrap">
          <table className="table static compact">
            <caption className="sr-only">Entries of {listKey}</caption>
            <thead><tr><th scope="col" className="num">#</th><th scope="col">Code</th><th scope="col">Label</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Order</span></th></tr></thead>
            <tbody>
              {active.map((r, i) => renderRow(r, i, active))}
              {retired.length > 0 && <tr className="no-hover"><th colSpan={5} scope="rowgroup" className="subhead-row">Retired — kept because existing requests may use them</th></tr>}
              {retired.map((r, i) => renderRow(r, i, retired))}
            </tbody>
          </table>
        </div>
        {canEdit && <button type="button" className="add-line" onClick={add}>+ Add entry</button>}
        <p className="muted small">Codes are permanent: they are stored on credit requests. Removing an entry retires it; it is never deleted.</p>
      </div>
      {canEdit && (
        <div className="form-foot">
          {dirty && <span className="grow muted small">Unsaved changes</span>}
          <button type="button" className="btn btn-secondary" disabled={!dirty || busy} onClick={() => { setRows(JSON.parse(orig)); setError(null); }}>Discard</button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy || invalid} onClick={save}>{busy ? 'Saving…' : 'Save list'}</button>
        </div>
      )}
    </section>
  );
}

export function ValueListsPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Value Lists' }]);
  const { hasRole } = useAuth();
  const ref = useReference();
  const canEdit = hasRole('config_admin');
  const keys = useApi(() => api.valueListKeys(), []);
  const layout = useApi(() => ref.loadLayout(), []);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');

  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const mod of layout.data?.modules ?? []) for (const s of mod.sections) for (const f of [...s.fields, ...(s.columns ?? [])]) {
      if (f.list) m.set(f.list, [...(m.get(f.list) ?? []), `${f.label} (${s.title})`]);
    }
    return m;
  }, [layout.data]);

  const selected = params.get('list') ?? keys.data?.[0] ?? null;
  const filtered = (keys.data ?? []).filter(k => !q.trim() || k.includes(q.trim().toLowerCase()) || humanize(k).toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="page">
      <PageHead title="Value Lists" subtitle={canEdit ? 'The choices offered in dropdowns. Changes go through maker-checker when your workspace has it on.' : 'The choices offered in dropdowns (read-only for your role).'} />
      <Loadable state={keys}>{() => (
        <div className="list-layout">
          <nav className="card side-list" aria-label="Value lists">
            <div className="side-search">
              <label htmlFor="vl-q" className="sr-only">Search lists</label>
              <input id="vl-q" type="search" placeholder="Search lists…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            {filtered.map(k => (
              <button key={k} type="button" className={k === selected ? 'active' : ''} aria-current={k === selected ? 'true' : undefined}
                onClick={() => setParams({ list: k }, { replace: true })}>
                <span className="side-item">
                  <span>{humanize(k)}</span>
                  <span className="muted small">{usedBy.get(k)?.length ?? 0} field{(usedBy.get(k)?.length ?? 0) === 1 ? '' : 's'}</span>
                </span>
                {layout.data?.lists[k] && <span className="count-chip" title="Active entries">{layout.data.lists[k].length}</span>}
              </button>
            ))}
            {filtered.length === 0 && <p className="muted small pad">No list matches.</p>}
          </nav>
          {selected ? <ListEditor key={selected} listKey={selected} usedBy={usedBy.get(selected) ?? []} canEdit={canEdit} /> : <p className="muted">No value lists.</p>}
        </div>
      )}</Loadable>
    </div>
  );
}
