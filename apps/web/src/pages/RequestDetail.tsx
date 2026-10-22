import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, type CreditRequestDetail, type RuleMessage, type TransitionAction, type WfDefinition, type WorkflowEvent } from '../api';
import { useAuth } from '../auth';
import { useReference } from '../reference';
import { formatDateTime, humanize, initials, trimDecimal } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/Badge';
import { Group, ReadOnly, Field } from '../components/Field';
import { Amount } from '../components/Money';
import { Modal } from '../components/Modal';
import { Timeline } from '../components/Timeline';
import { useToast } from '../components/Toast';
import { CLIENT_DETAILS_KEY, RequestForm } from '../components/RequestForm';

function TransitionModal({ action, onCancel, onConfirm }: {
  action: TransitionAction; onCancel: () => void; onConfirm: (remarks: string) => Promise<void>;
}) {
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (action.remarksRequired && !remarks.trim()) { setError('Remarks are required for this action'); return; }
    setBusy(true);
    try { await onConfirm(remarks.trim()); } finally { setBusy(false); }
  };
  return (
    <Modal title={action.label} onClose={onCancel} footer={<>
      <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Working…' : action.label}</button>
    </>}>
      <p style={{ marginTop: 0 }}>The request moves to the next stage and the step is recorded in the workflow history and the audit trail.</p>
      <Field label={action.remarksRequired ? 'Remarks' : 'Remarks (optional)'} required={action.remarksRequired} error={error ?? undefined} wide>
        <textarea rows={4} value={remarks} onChange={e => { setRemarks(e.target.value); setError(null); }} maxLength={2000} />
      </Field>
    </Modal>
  );
}

export function RequestDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const ref = useReference();
  const { hasRole } = useAuth();
  const [req, setReq] = useState<CreditRequestDetail | null>(null);
  const [history, setHistory] = useState<WorkflowEvent[] | null>(null);
  const [def, setDef] = useState<WfDefinition | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [pending, setPending] = useState<TransitionAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [warnings, setWarnings] = useState<RuleMessage[]>(() => (location.state as { warnings?: RuleMessage[] } | null)?.warnings ?? []);

  useCrumbs([{ label: 'Credit' }, { label: 'Credit Requests', to: '/requests' }, { label: req?.requestNumber ?? '…' }]);
  useEffect(() => { void ref.loadFields().catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [r, h] = await Promise.all([api.getRequest(id), api.history(id)]);
      setReq(r); setHistory(h); setActionError(null);
      api.workflow(r.requestType).then(w => setDef(w.definition)).catch(() => setDef(null));
    } catch (e) { setLoadError(e); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (req) document.title = `${req.requestNumber} · Creditum`; }, [req]);

  if (loadError && !req) return <div className="page"><ErrorAlert error={loadError} onReload={load} /></div>;
  if (!req || !history) return <div className="page"><Spinner /></div>;

  const base = ref.baseCurrency?.code;
  const detailsField = ref.field(CLIENT_DETAILS_KEY);
  const details = req.fields[CLIENT_DETAILS_KEY];
  const canEdit = req.editable && hasRole('relationship_officer', 'credit_analyst');
  const missing = actionError instanceof ApiError ? actionError.missingFields : [];

  const doTransition = async (a: TransitionAction, remarks: string) => {
    setActionError(null);
    try {
      const next = await api.transition(req.id, a.action, req.rowVersion, remarks || undefined);
      setPending(null);
      setReq(next);
      setHistory(await api.history(req.id));
      setWarnings([]);
      toast.show(`${next.requestNumber}: ${a.label} — now ${next.statusLabel}`, 'ok');
    } catch (e) {
      setPending(null);
      setActionError(e);
    }
  };

  const stateLabel = (code: string) => def?.states.find(s => s.code === code)?.label ?? humanize(code);
  const actionLabel = (from: string, action: string) => def?.transitions.find(t => t.from === from && t.action === action)?.label ?? humanize(action);
  const timeline = history.map(h => ({
    id: h.id, statusCode: h.toState, marker: initials(h.actorName),
    title: actionLabel(h.fromState, h.actionCode), meta: <>{h.actorName} · {stateLabel(h.fromState)} <span className="rtl-flip" aria-hidden="true">→</span><span className="sr-only">to</span> {stateLabel(h.toState)}</>,
    when: h.occurredAt, remarks: h.remarks,
  }));
  timeline.unshift({ id: 'created', statusCode: 'draft', marker: '+', title: 'Created', meta: <>Request {req.requestNumber} created</>, when: req.createdAt, remarks: null });

  return (
    <div className="page">
      <Link to="/requests" className="back"><span className="rtl-flip" aria-hidden="true">←</span> Credit requests</Link>
      <PageHead title={req.requestNumber} badge={<StatusBadge code={req.status} label={req.statusLabel} />}
        subtitle={<>{req.borrowerName} · {ref.requestTypeLabel(req.requestType)} · updated {formatDateTime(req.updatedAt)}</>}
        actions={canEdit && !editing ? <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>Edit request</button> : undefined} />

      {warnings.length > 0 && <Alert tone="warning"><strong>Rule warnings</strong><ul>{warnings.map(w => <li key={w.rule + w.message}>{w.message} <span className="muted small">({w.rule})</span></li>)}</ul></Alert>}
      {actionError instanceof ApiError && actionError.isConflict ? (
        <Alert tone="warning" action={<button type="button" className="btn btn-secondary btn-sm" onClick={load}>Reload</button>}>
          This request was changed by someone else — Reload to see the latest version before acting.
        </Alert>
      ) : actionError ? (
        <Alert tone="error">{errorMessage(actionError)}{missing.length > 0 && <ul>{missing.map(m => <li key={m.field}>{ref.field(m.field)?.label ?? m.field}: {m.message}</li>)}</ul>}</Alert>
      ) : null}

      <div className="detail-grid">
        <div>
          {editing ? (
            <RequestForm initial={req} submitLabel="Save changes" onCancel={() => setEditing(false)} onReload={() => { setEditing(false); void load(); }}
              onSubmit={async input => {
                const res = await api.updateRequest(req.id, req.rowVersion, input);
                setReq(res.request); setWarnings(res.warnings); setEditing(false); setActionError(null);
                toast.show(`${res.request.requestNumber} saved`, 'ok');
                return res.warnings;
              }} />
          ) : (
            <div className="section-groups">
              <Group title="Borrower">
                <div className="field-grid">
                  <ReadOnly label="Borrower name">{req.borrowerName}</ReadOnly>
                  <ReadOnly label="Borrower reference">{req.borrowerRef}</ReadOnly>
                  <ReadOnly label="Request type">{ref.requestTypeLabel(req.requestType)}</ReadOnly>
                </div>
              </Group>
              <Group title="Facility request">
                <div className="field-grid">
                  <ReadOnly label="Requested amount" mono><Amount value={req.requestedAmount} code={req.currencyCode} showCode={false} /></ReadOnly>
                  <ReadOnly label="Currency">{req.currencyCode}{ref.currency(req.currencyCode) ? ` — ${ref.currency(req.currencyCode)!.name}` : ''}</ReadOnly>
                  <ReadOnly label={`Base amount${base ? ` (${base})` : ''}`} mono><Amount value={req.baseAmount} code={base} showCode={false} /></ReadOnly>
                  <ReadOnly label="FX rate used" mono>{trimDecimal(req.fxRateUsed)}{base && req.currencyCode !== base ? <span className="muted small"> {req.currencyCode} → {base}</span> : null}</ReadOnly>
                  <ReadOnly label="Required authority level">{ref.levelName(req.requiredLevel)} <span className="muted small">({req.requiredLevel})</span></ReadOnly>
                </div>
              </Group>
              <Group title={detailsField?.group ?? 'Client request'}>
                <div className={missing.some(m => m.field === CLIENT_DETAILS_KEY) ? 'has-error' : undefined}>
                  <ReadOnly label={detailsField?.label ?? 'Client Request Details'} wide>{typeof details === 'string' ? details : ''}</ReadOnly>
                  {missing.some(m => m.field === CLIENT_DETAILS_KEY) && <p className="field-error">{missing.find(m => m.field === CLIENT_DETAILS_KEY)!.message}{canEdit && <> — <button type="button" className="link-btn small" onClick={() => setEditing(true)}>edit the request</button></>}</p>}
                </div>
              </Group>
            </div>
          )}
        </div>

        <aside className="side-col">
          <section className="card" aria-labelledby="actions-head">
            <div className="card-head"><h3 id="actions-head">Actions</h3></div>
            <div className="card-body">
              {req.actions.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No action is available to you at this stage.</p> : (
                <div className="stack">
                  {req.actions.map((a, i) => (
                    <button key={a.action} type="button" className={`btn ${i === 0 && !/back|declin|reject/.test(a.action) ? 'btn-primary' : /declin|reject/.test(a.action) ? 'btn-danger-ghost' : 'btn-secondary'}`}
                      onClick={() => setPending(a)} disabled={editing}>{a.label}</button>
                  ))}
                </div>
              )}
              <p className="muted small" style={{ margin: '12px 0 0' }}>Version {req.rowVersion}. Actions are recorded against this version.</p>
            </div>
          </section>
          <section className="card" aria-labelledby="hist-head">
            <div className="card-head"><h3 id="hist-head">Workflow history</h3></div>
            <div className="card-body"><Timeline items={timeline} /></div>
          </section>
          <section className="card" aria-label="Audit">
            <div className="card-body small muted">
              Every change to this request is recorded in the tamper-evident audit trail under <span className="icode">{req.requestNumber}</span>.
              {hasRole('auditor', 'config_admin') && <> <button type="button" className="link-btn small" onClick={() => navigate('/admin/audit')}>Open audit trail</button></>}
            </div>
          </section>
        </aside>
      </div>

      {pending && <TransitionModal action={pending} onCancel={() => setPending(null)} onConfirm={r => doTransition(pending, r)} />}
    </div>
  );
}
