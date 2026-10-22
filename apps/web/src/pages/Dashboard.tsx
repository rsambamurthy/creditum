import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type CreditRequest, type CreditRequestDetail } from '../api';
import { CREDIT_ROLES, useAuth, useMe } from '../auth';
import { useApi } from '../hooks';
import { useReference } from '../reference';
import { relativeTime, statusTone } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { StatTiles } from '../components/StatTiles';
import { StatusBadge } from '../components/Badge';
import { Amount } from '../components/Money';

/** Most recent requests whose available actions are checked for "My actions". */
const ACTION_SCAN = 30;

function statusTiles(rows: CreditRequest[]) {
  const by = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    const e = by.get(r.status) ?? { label: r.statusLabel, count: 0 };
    e.count += 1; by.set(r.status, e);
  }
  return [...by.entries()].map(([code, e]) => ({ key: code, label: e.label, count: e.count, tone: statusTone(code) }));
}

function MyActions({ rows }: { rows: CreditRequest[] }) {
  const [details, setDetails] = useState<CreditRequestDetail[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    const recent = rows.slice(0, ACTION_SCAN);
    Promise.all(recent.map(r => api.getRequest(r.id).catch(() => null)))
      .then(ds => { if (live) setDetails(ds.filter((d): d is CreditRequestDetail => !!d && d.actions.length > 0)); })
      .catch(e => { if (live) setError(e); });
    return () => { live = false; };
  }, [rows]);
  if (error) return <ErrorAlert error={error} />;
  if (!details) return <Spinner label="Checking your actions…" />;
  if (!details.length) return <p className="muted" style={{ margin: 0 }}>Nothing is waiting for you.</p>;
  return (
    <ul className="plain-list">
      {details.map(d => (
        <li key={d.id}>
          <Link to={`/requests/${d.id}`} className="strong">{d.requestNumber}</Link>
          <span>{d.borrowerName}</span>
          <StatusBadge code={d.status} label={d.statusLabel} />
          <span className="muted small grow" style={{ textAlign: 'end' }}><Amount value={d.requestedAmount} code={d.currencyCode} /></span>
          <span className="block small muted">Available: {d.actions.map(a => a.label).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}

function CreditDashboard() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const state = useApi(() => api.listRequests(), []);
  const rows = state.data;
  const tiles = useMemo(() => (rows ? statusTiles(rows) : []), [rows]);

  if (state.error) return <ErrorAlert error={state.error} onReload={state.reload} />;
  if (!rows) return <Spinner />;
  return (
    <>
      <StatTiles label="Credit requests by status" tiles={[{ key: '', label: 'All requests', count: rows.length, tone: 'brand' }, ...tiles]}
        onSelect={k => navigate(k ? `/requests?status=${encodeURIComponent(k)}` : '/requests')} />
      <div className="dash-grid">
        <section className="card" aria-labelledby="my-actions">
          <div className="card-head"><h3 id="my-actions">My actions</h3><span className="muted small">Requests where you can act now</span></div>
          <div className="card-body"><MyActions rows={rows} /></div>
        </section>
        <section className="card" aria-labelledby="recent">
          <div className="card-head"><h3 id="recent">Recently updated</h3><Link to="/requests" className="small">View all</Link></div>
          <div className="card-body">
            {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No credit requests yet.{hasRole('relationship_officer') && <> <Link to="/requests/new">Create the first one</Link>.</>}</p> : (
              <ul className="plain-list">
                {[...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6).map(r => (
                  <li key={r.id}>
                    <Link to={`/requests/${r.id}`} className="strong">{r.requestNumber}</Link>
                    <span className="grow">{r.borrowerName}</span>
                    <StatusBadge code={r.status} label={r.statusLabel} />
                    <span className="muted small">{relativeTime(r.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function AdminSummary() {
  const { hasRole } = useAuth();
  const ref = useReference();
  const isAdmin = hasRole('config_admin', 'auditor');
  const fields = useApi(() => (isAdmin ? ref.loadFields() : Promise.resolve([])), [isAdmin]);
  const changes = useApi(() => (isAdmin ? api.pendingChanges() : Promise.resolve([])), [isAdmin]);
  const rules = useApi(() => (isAdmin ? api.rules() : Promise.resolve([])), [isAdmin]);
  if (!isAdmin) return null;
  const tile = (n: number | undefined, label: string, sub: string, to: string) => (
    <Link to={to} className="card tile"><span className="tile-n">{n ?? '…'}</span><span className="tile-l">{label}</span><span className="tile-sub">{sub}</span></Link>
  );
  return (
    <section aria-labelledby="admin-head" style={{ marginTop: 20 }}>
      <h2 id="admin-head" className="sub-head">Administration</h2>
      <div className="tiles">
        {tile(fields.data?.length, 'Fields in library', `${fields.data?.filter(f => f.overrideVersion !== null).length ?? '…'} with workspace overrides`, '/admin/fields')}
        {tile(changes.data?.length, 'Pending changes', 'Awaiting a second administrator', '/admin/config?tab=pending')}
        {tile(rules.data?.length, 'Rules in force', `${rules.data?.filter(r => r.scope === 'tenant').length ?? '…'} workspace-specific`, '/admin/rules')}
        {tile(ref.currencies.length, 'Currencies', `Base: ${ref.baseCurrency?.code ?? '—'}`, '/admin/config?tab=currencies')}
        {tile(ref.authorityLevels.length, 'Authority levels', 'Delegated authority matrix', '/admin/config?tab=authority')}
        {tile(ref.requestTypes.length, 'Request types', 'Each with its own workflow', '/admin/workflows')}
      </div>
    </section>
  );
}

export function DashboardPage() {
  const me = useMe();
  const { hasRole } = useAuth();
  useCrumbs([{ label: 'Overview' }, { label: 'Dashboard' }]);
  const isCredit = hasRole(...CREDIT_ROLES);
  return (
    <div className="page">
      <PageHead title={`Welcome, ${me.displayName.split(' ')[0]}`} subtitle={`${me.tenant.name ?? me.tenant.code} · credit origination overview`}
        actions={hasRole('relationship_officer') ? <Link to="/requests/new" className="btn btn-primary">+ New credit request</Link> : undefined} />
      {isCredit && <CreditDashboard />}
      <AdminSummary />
      <section className="card" style={{ marginTop: 20 }} aria-labelledby="quick">
        <div className="card-head"><h3 id="quick">Quick links</h3></div>
        <div className="card-body">
          <div className="btn-row">
            {isCredit && <Link className="btn btn-secondary btn-sm" to="/requests">Credit requests</Link>}
            {hasRole('relationship_officer') && <Link className="btn btn-secondary btn-sm" to="/requests/new">New credit request</Link>}
            {hasRole('config_admin', 'auditor') && <>
              <Link className="btn btn-secondary btn-sm" to="/admin/fields">Field library</Link>
              <Link className="btn btn-secondary btn-sm" to="/admin/config">Configuration</Link>
              <Link className="btn btn-secondary btn-sm" to="/admin/audit">Audit trail</Link>
            </>}
          </div>
        </div>
      </section>
    </div>
  );
}
