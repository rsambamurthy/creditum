import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ConfigChange, type Parameter } from '../api';
import { useAuth, useMe } from '../auth';
import { useApi } from '../hooks';
import { useReference } from '../reference';
import { formatDateTime, formatDecimal, humanize, prettyJson } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { ErrorAlert, Loadable, PageHead } from '../components/Feedback';
import { Badge } from '../components/Badge';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';

type Tab = 'parameters' | 'currencies' | 'lists' | 'authority' | 'pending';
const TABS: { key: Tab; label: string }[] = [
  { key: 'parameters', label: 'Parameters' }, { key: 'currencies', label: 'Currencies' }, { key: 'lists', label: 'Value lists' },
  { key: 'authority', label: 'Delegated authority' }, { key: 'pending', label: 'Pending changes' },
];

function ParamEditor({ p, onDone }: { p: Parameter; onDone: (saved: boolean) => void }) {
  const toast = useToast();
  const [value, setValue] = useState(p.paramValue);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      toast.configResult(await api.setParameter(p.paramKey, value, p.rowVersion), `${p.paramKey} updated`);
      onDone(true);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 6 }} onClick={e => e.stopPropagation()}>
      <div className="inline-edit">
        <label htmlFor={`pv-${p.id}`} className="sr-only">New value for {p.paramKey}</label>
        {p.valueType === 'boolean' ? (
          <select id={`pv-${p.id}`} value={value} onChange={e => setValue(e.target.value)}><option value="true">true</option><option value="false">false</option></select>
        ) : (
          <input id={`pv-${p.id}`} value={value} onChange={e => setValue(e.target.value)} inputMode={p.valueType === 'decimal' || p.valueType === 'integer' ? 'decimal' : undefined}
            onKeyDown={e => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') onDone(false); }} autoFocus />
        )}
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>Save</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDone(false)} disabled={busy}>Cancel</button>
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}

function ParametersTab({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => api.parameters(), []);
  const [editing, setEditing] = useState<string | null>(null);
  const cols: Column<Parameter>[] = [
    { key: 'key', header: 'Key', cell: p => <span className="icode">{p.paramKey}</span> },
    { key: 'type', header: 'Type', cell: p => <Badge tone="neutral">{p.valueType}</Badge> },
    { key: 'value', header: 'Value', cell: p => editing === p.paramKey ? <ParamEditor p={p} onDone={saved => { setEditing(null); if (saved) void state.reload(); }} />
      : <span className="mono-num strong">{p.valueType === 'decimal' ? formatDecimal(p.paramValue) : p.paramValue}</span> },
    { key: 'desc', header: 'Description', hideSm: true, cell: p => <span className="small">{p.description ?? '—'}</span> },
    { key: 'ver', header: 'Version', num: true, cell: p => p.rowVersion },
    { key: 'act', header: <span className="sr-only">Actions</span>, className: 'actions', cell: p => canEdit && editing !== p.paramKey
      ? <button type="button" className="link-btn" onClick={() => setEditing(p.paramKey)} aria-label={`Edit ${p.paramKey}`}>Edit</button> : null },
  ];
  return <Loadable state={state}>{rows => <DataTable rows={rows} columns={cols} rowKey={p => p.id} caption="Configuration parameters" />}</Loadable>;
}

function CurrenciesTab() {
  const ref = useReference();
  const state = useApi(() => api.currencies(), []);
  return (
    <Loadable state={state}>{rows => (
      <DataTable rows={rows} rowKey={c => c.id} caption="Currencies" columns={[
        { key: 'code', header: 'Code', cell: c => <span className="strong mono">{c.code}</span> },
        { key: 'name', header: 'Name', cell: c => <>{c.name} {c.isBase && <Badge tone="info" small>Base</Badge>}</> },
        { key: 'mu', header: 'Minor units', num: true, cell: c => c.minorUnits },
        { key: 'rnd', header: 'Rounding', cell: c => humanize(c.roundingMode) },
        { key: 'act', header: 'Status', cell: c => c.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Inactive</Badge> },
        { key: 'use', header: 'Base for limits', hideSm: true, cell: c => c.code === ref.baseCurrency?.code ? 'Yes — authority limits and thresholds' : '—' },
      ]} />
    )}</Loadable>
  );
}

/** Read-only preview; editing lives on the Value Lists page. */
function ValueListsTab() {
  const keys = useApi(() => api.valueListKeys(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const active = selected ?? keys.data?.[0] ?? null;
  const entries = useApi(() => (active ? api.valueList(active) : Promise.resolve([])), [active]);
  return (
    <Loadable state={keys}>{ks => (
      <>
      <p className="small" style={{ margin: '0 0 12px' }}><Link to="/admin/value-lists">Open the Value Lists editor</Link> to add, rename, reorder or retire entries.</p>
      <div className="list-layout">
        <nav className="card side-list" aria-label="Value lists">
          {ks.map(k => <button key={k} type="button" className={k === active ? 'active' : ''} aria-current={k === active ? 'true' : undefined} onClick={() => setSelected(k)}><span>{humanize(k)}</span><span className="icode">{k}</span></button>)}
          {ks.length === 0 && <p className="muted small pad">No value lists.</p>}
        </nav>
        <section className="card" aria-label={active ? `Entries of ${active}` : 'Entries'}>
          <Loadable state={entries}>{rows => (
            <DataTable rows={rows} rowKey={e => e.id} caption="Value list entries" columns={[
              { key: 'o', header: 'Order', num: true, cell: e => e.sortOrder },
              { key: 'c', header: 'Code', cell: e => <span className="icode">{e.code}</span> },
              { key: 'l', header: 'Label', cell: e => e.label },
              { key: 'a', header: 'Status', cell: e => e.isActive ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge> },
            ]} />
          )}</Loadable>
        </section>
      </div>
      </>
    )}</Loadable>
  );
}

function AuthorityTab() {
  const ref = useReference();
  const state = useApi(() => api.authorityLevels(), []);
  const base = ref.baseCurrency;
  return (
    <Loadable state={state}>{rows => (
      <>
        <p className="muted small" style={{ margin: '0 0 12px' }}>Limits are in the base currency{base ? ` (${base.code})` : ''}. A request needs the lowest level whose limit covers its base amount; that level’s approver role or any higher level may approve.</p>
        <DataTable rows={rows} rowKey={l => l.id} caption="Delegated authority levels" columns={[
          { key: 'rank', header: 'Rank', num: true, cell: l => l.rankNo },
          { key: 'code', header: 'Level', cell: l => <span className="icode">{l.levelCode}</span> },
          { key: 'name', header: 'Name', cell: l => <span className="strong">{l.name}</span> },
          { key: 'max', header: `Max amount${base ? ` (${base.code})` : ''}`, num: true, cell: l => l.maxAmount === null ? <Badge tone="info">Unlimited</Badge> : <span className="mono-num">{formatDecimal(l.maxAmount, base?.minorUnits)}</span> },
          { key: 'role', header: 'Approver role', cell: l => humanize(l.approverRole) },
        ]} />
      </>
    )}</Loadable>
  );
}

function PendingTab({ canDecide, onCount }: { canDecide: boolean; onCount: (n: number) => void }) {
  const me = useMe();
  const toast = useToast();
  const state = useApi(async () => { const r = await api.pendingChanges(); onCount(r.length); return r; }, []);
  const [rejecting, setRejecting] = useState<ConfigChange | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (c: ConfigChange, approve: boolean, n?: string) => {
    setBusy(c.id); setError(null);
    try {
      const r = await api.decideChange(c.id, approve, n);
      toast.show(r.status === 'applied' ? `Change to ${c.targetRef} approved and applied` : `Change to ${c.targetRef} rejected`, 'ok');
      setRejecting(null); setNote('');
      await state.reload();
    } catch (e) { setError(e); setRejecting(null); } finally { setBusy(null); }
  };

  return (
    <>
      <ErrorAlert error={error} onReload={state.reload} />
      <Loadable state={state}>{rows => (
        <DataTable rows={rows} rowKey={c => c.id} caption="Pending configuration changes" empty="No changes are waiting for approval." columns={[
          { key: 'when', header: 'Submitted', cell: c => <span className="nowrap small">{formatDateTime(c.createdAt)}</span> },
          { key: 'what', header: 'Change', cell: c => <><Badge tone="warn">{humanize(c.targetType)}</Badge> <span className="icode">{c.targetRef}</span></> },
          { key: 'payload', header: 'Proposed', cell: c => <details><summary className="small" style={{ cursor: 'pointer' }}>View</summary><pre className="code light">{prettyJson(c.payload)}</pre></details> },
          { key: 'maker', header: 'Maker', cell: c => c.makerId === me.userId ? <span className="strong">You</span> : <span className="mono small" title={c.makerId}>{c.makerId.slice(0, 8)}</span> },
          { key: 'act', header: <span className="sr-only">Decision</span>, className: 'actions', cell: c => !canDecide ? <span className="muted small">View only</span> : (
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null}
                title={c.makerId === me.userId ? 'You made this change — a second administrator must approve it' : undefined}
                onClick={() => decide(c, true)}>Approve</button>
              <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy !== null} onClick={() => setRejecting(c)}>Reject</button>
            </div>) },
        ]} />
      )}</Loadable>
      {rejecting && (
        <Modal title={`Reject change to ${rejecting.targetRef}`} onClose={() => setRejecting(null)} footer={<>
          <button type="button" className="btn btn-secondary" onClick={() => setRejecting(null)}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => decide(rejecting, false, note.trim() || undefined)} disabled={busy !== null}>Reject change</button>
        </>}>
          <Field label="Reason (optional)" wide><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></Field>
        </Modal>
      )}
    </>
  );
}

export function ConfigurationPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Configuration' }]);
  const { hasRole } = useAuth();
  const canEdit = hasRole('config_admin');
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(t => t.key === params.get('tab'))?.key ?? 'parameters') as Tab;
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  useApi(async () => { const r = await api.pendingChanges(); setPendingCount(r.length); return r; }, []);

  return (
    <div className="page">
      <PageHead title="Configuration" subtitle="Workspace parameters, currencies, value lists and the delegated authority matrix. Changes are governed and audited." />
      <section className="card">
        <div className="tabs" role="tablist" aria-label="Configuration sections">
          {TABS.map(t => (
            <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`}
              className={tab === t.key ? 'active' : ''} onClick={() => setParams({ tab: t.key }, { replace: true })}>
              {t.label}{t.key === 'pending' && pendingCount ? <span className="tab-count">{pendingCount}</span> : null}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} style={{ padding: tab === 'lists' || tab === 'authority' ? 16 : 0 }}>
          {tab === 'parameters' && <ParametersTab canEdit={canEdit} />}
          {tab === 'currencies' && <CurrenciesTab />}
          {tab === 'lists' && <ValueListsTab />}
          {tab === 'authority' && <AuthorityTab />}
          {tab === 'pending' && <PendingTab canDecide={canEdit} onCount={setPendingCount} />}
        </div>
      </section>
    </div>
  );
}
