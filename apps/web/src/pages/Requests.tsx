import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type CreditRequest } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { useReference } from '../reference';
import { formatDateTime, statusTone } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { StatTiles } from '../components/StatTiles';
import { StatusBadge } from '../components/Badge';
import { DataTable, type Column } from '../components/DataTable';
import { Amount } from '../components/Money';

export function RequestsPage() {
  useCrumbs([{ label: 'Credit' }, { label: 'Credit Requests' }]);
  const { hasRole } = useAuth();
  const ref = useReference();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const state = useApi(() => api.listRequests(), []);
  const rows = state.data;

  const tiles = useMemo(() => {
    const by = new Map<string, { label: string; count: number }>();
    for (const r of rows ?? []) { const e = by.get(r.status) ?? { label: r.statusLabel, count: 0 }; e.count++; by.set(r.status, e); }
    return [{ key: '', label: 'All', count: rows?.length ?? 0, tone: 'brand' as const },
      ...[...by.entries()].map(([k, e]) => ({ key: k, label: e.label, count: e.count, tone: statusTone(k) }))];
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter(r => (!status || r.status === status) &&
      (!needle || [r.requestNumber, r.borrowerName, r.borrowerRef].some(v => v.toLowerCase().includes(needle))));
  }, [rows, status, q]);

  const base = ref.baseCurrency?.code;
  const columns: Column<CreditRequest>[] = [
    { key: 'num', header: 'Number', cell: r => <span className="strong nowrap">{r.requestNumber}</span> },
    { key: 'borrower', header: 'Borrower', cell: r => <><div>{r.borrowerName}</div><div className="muted small">{r.borrowerRef}</div></> },
    { key: 'type', header: 'Type', cell: r => ref.requestTypeLabel(r.requestType), hideSm: true },
    { key: 'amount', header: 'Amount', num: true, cell: r => <Amount value={r.requestedAmount} code={r.currencyCode} /> },
    { key: 'base', header: `Base amount${base ? ` (${base})` : ''}`, num: true, hideSm: true, cell: r => <Amount value={r.baseAmount} code={base} showCode={false} /> },
    { key: 'level', header: 'Required level', hideSm: true, cell: r => <span title={r.requiredLevel}>{ref.levelName(r.requiredLevel)}</span> },
    { key: 'status', header: 'Status', cell: r => <StatusBadge code={r.status} label={r.statusLabel} /> },
    { key: 'updated', header: 'Updated', hideSm: true, cell: r => <span className="nowrap muted small">{formatDateTime(r.updatedAt)}</span> },
  ];

  const setStatus = (k: string) => { const p = new URLSearchParams(params); if (k) p.set('status', k); else p.delete('status'); setParams(p, { replace: true }); };

  return (
    <div className="page">
      <PageHead title="Credit Requests" subtitle="Corporate credit requests in this workspace, newest first."
        actions={hasRole('relationship_officer') ? <Link to="/requests/new" className="btn btn-primary">+ New credit request</Link> : undefined} />
      {state.error ? <ErrorAlert error={state.error} onReload={state.reload} /> : !rows ? <Spinner /> : (
        <>
          <StatTiles label="Filter by status" tiles={tiles} active={status} onSelect={setStatus} />
          <section className="card" aria-label="Credit requests">
            <div className="toolbar">
              <label htmlFor="req-q" className="sr-only">Search requests</label>
              <input id="req-q" type="search" className="search" placeholder="Search number, borrower or reference…" value={q} onChange={e => setQ(e.target.value)} />
              <span className="muted small grow" style={{ textAlign: 'end' }} aria-live="polite">{filtered.length} of {rows.length}</span>
            </div>
            <DataTable rows={filtered} columns={columns} rowKey={r => r.id} caption="Credit requests"
              onRowClick={r => navigate(`/requests/${r.id}`)} rowLabel={r => `Open ${r.requestNumber}, ${r.borrowerName}`}
              empty={rows.length === 0 ? 'No credit requests yet.' : 'No requests match the filter.'} />
          </section>
        </>
      )}
    </div>
  );
}
