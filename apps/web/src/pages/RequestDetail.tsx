import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, type BookingResult, type CoreBankingStatus, type PullResult, type RequestIntegration, type CreditRequestDetail, type FormValue, type Layout, type MissingEntry, type RuleMessage, type TransitionAction, type WfDefinition, type WorkflowEvent } from '../api';
import { useAuth } from '../auth';
import { useReference } from '../reference';
import { formatDateTime, humanize, initials, trimDecimal } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ErrorAlert, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/Badge';
import { ReadOnly, Field } from '../components/Field';
import { Amount } from '../components/Money';
import { Modal } from '../components/Modal';
import { Timeline } from '../components/Timeline';
import { useToast } from '../components/Toast';
import { formFields, RequestForm } from '../components/RequestForm';
import { FieldInput } from '../forms/FieldInput';
import { CreditRequestModules, type ModulesHandle } from '../forms/CreditRequestModules';

/** Missing mandatory fields reported when a step was refused, grouped by module, each linking to its field. */
function MissingFieldsModal({ missing, layout, onGo, onClose }: {
  missing: MissingEntry[]; layout: Layout | null; onGo: (m: MissingEntry) => void; onClose: () => void;
}) {
  const modules = layout?.modules ?? [];
  const sectionTitle = (code: string) => modules.flatMap(m => m.sections).find(s => s.code === code)?.title ?? code;
  const groups = [...new Set(missing.map(m => m.module))].map(code => ({
    code, title: modules.find(m => m.code === code)?.title ?? code, items: missing.filter(m => m.module === code),
  }));
  return (
    <Modal wide title="Mandatory fields missing" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <p style={{ marginTop: 0 }}>This step needs every mandatory field to be filled. {missing.length} field{missing.length === 1 ? ' is' : 's are'} still empty:</p>
      <div className="missing-groups">
        {groups.map(g => (
          <section key={g.code} aria-label={g.title}>
            <h3 className="sub-head">{g.title} <span className="badge badge-warn sm">{g.items.length}</span></h3>
            <ul className="missing-links">
              {g.items.map(m => (
                <li key={`${m.key}@${m.rowKey ?? ''}`}>
                  <button type="button" className="link-btn" onClick={() => onGo(m)}>{m.label}</button>
                  <span className="muted small"> · {m.sectionTitle ?? sectionTitle(m.section)}{m.rowKey ? ' (table row)' : ''}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

const show = (v: FormValue | undefined) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

/** What a refresh from the bank systems changed, system by system. */
function PullResultModal({ result, onClose }: { result: PullResult; onClose: () => void }) {
  const STATUS: Record<string, string> = { pulled: 'Updated', skipped: 'Nothing to take over', failed: 'Not reached' };
  return (
    <Modal wide title="Refreshed from bank systems" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <p style={{ marginTop: 0 }}>As of {formatDateTime(result.pulledAt)}. Values entered by users were kept.</p>
      {result.systems.length === 0 && <p className="muted">No bank system is connected for this workspace.</p>}
      {result.systems.map(sys => {
        const nothing = sys.status === 'pulled' && !sys.changes.length && !sys.tables.length;
        return (
          <section key={sys.system} className="cb-system">
            <h3 className="sub-head">{sys.label} <span className={`badge sm ${sys.status === 'failed' ? 'badge-warn' : 'badge-neutral'}`}>{nothing ? 'No changes' : STATUS[sys.status]}</span></h3>
            {sys.message && <p className="muted small" style={{ margin: '0 0 6px' }}>{sys.message}</p>}
            {sys.changes.length > 0 && (
              <table className="cb-changes"><thead><tr><th>Field</th><th>Section</th><th>Before</th><th>Now</th></tr></thead>
                <tbody>{sys.changes.map(c => <tr key={c.field}><td>{c.label}</td><td className="muted">{c.section}</td><td className="muted">{show(c.before)}</td><td><strong>{show(c.after)}</strong></td></tr>)}</tbody></table>
            )}
            {sys.tables.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingInlineStart: 18 }}>
                {sys.tables.map(t => <li key={t.grid}>{t.label} rows: {[t.added && `${t.added} added`, t.updated && `${t.updated} updated`, t.removed && `${t.removed} no longer in ${sys.label.toLowerCase()}`].filter(Boolean).join(', ')}</li>)}
              </ul>
            )}
            {sys.warnings.length > 0 && <Alert tone="warning"><strong>Not taken over</strong><ul>{sys.warnings.map(w => <li key={w}>{w}</li>)}</ul></Alert>}
          </section>
        );
      })}
    </Modal>
  );
}

function BookingModal({ label, requestNumber, result, onConfirm, onClose }: {
  label: string; requestNumber: string; result: BookingResult | null; onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = async () => { setBusy(true); setError(null); try { await onConfirm(); } catch (e) { setError(e); } finally { setBusy(false); } };
  return (
    <Modal title={result ? `Booked in ${label.toLowerCase()}` : `Book in ${label.toLowerCase()}`} onClose={onClose} footer={result
      ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      : <><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Booking…' : 'Book limits and collateral'}</button></>}>
      {error ? <Alert tone="error">{errorMessage(error)}</Alert> : null}
      {!result ? (
        <p style={{ marginTop: 0 }}>The approved facility lines (new, increased, renewed or extended, with a proposed limit) and the new collateral of {requestNumber} are
          sent to {label.toLowerCase()}. The limit references, accounts and contract references come back into Credit Administration. A request is booked once.</p>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>{formatDateTime(result.bookedAt)} — see Credit Administration for the booked lines.</p>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {result.limits.length > 0 && <li>Limits: <span className="icode">{result.limits.join(', ')}</span></li>}
            {result.collateral.length > 0 && <li>Collateral: <span className="icode">{result.collateral.join(', ')}</span></li>}
          </ul>
          {result.warnings.length > 0 && <Alert tone="warning"><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></Alert>}
        </>
      )}
    </Modal>
  );
}

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
  const [dataDirty, setDataDirty] = useState(false);
  const [mandatory, setMandatory] = useState<MissingEntry[] | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const modulesRef = useRef<ModulesHandle>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [integ, setInteg] = useState<RequestIntegration | null>(null);
  const [cb, setCb] = useState<CoreBankingStatus | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<PullResult | null>(null);
  const [booking, setBooking] = useState<{ result: BookingResult | null } | null>(null);
  useEffect(() => { api.coreBankingStatus().then(setCb).catch(() => setCb(null)); }, []);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => { if (menuRef.current) menuRef.current.open = false; };
  const onVersion = useCallback((v: number) => setReq(r => (r && r.rowVersion !== v ? { ...r, rowVersion: v } : r)), []);
  useEffect(() => { ref.loadLayout().then(setLayout).catch(() => setLayout(null)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  const formExtra = formFields(layout);
  const canEdit = req.editable && hasRole('relationship_officer', 'credit_analyst');
  const cbLabel = cb?.label ?? 'Core banking';
  const cbReady = !!cb?.configured && cb.enabled;
  const connected = (cb?.systems ?? []).filter(x => x.configured && x.enabled);
  const canPull = connected.length > 0 && canEdit;
  const pulledFrom = (integ?.sources ?? []).filter(x => x.pulledAt).map(x => `${x.label}: ${formatDateTime(x.pulledAt!)}`).join('\n');
  const canBook = cbReady && hasRole('credit_admin') && cb!.bookingStates.includes(req.status) && !integ?.bookedAt;
  const doPull = async () => {
    if (dataDirty) { toast.show('Save or discard your changes before refreshing', 'info'); return; }
    setPulling(true); setActionError(null);
    try {
      const res = await api.pullBankData(req.id);
      setPullResult(res);
      await load();
      await modulesRef.current?.reload();
    } catch (e) { setActionError(e); } finally { setPulling(false); }
  };
  const doBook = async () => {
    const res = await api.bookCoreBanking(req.id);
    setBooking({ result: res });
    toast.show(`${req.requestNumber} booked in ${cbLabel.toLowerCase()}`, 'ok');
    await load();
    await modulesRef.current?.reload();
  };
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
      for (const w of next.warnings ?? []) toast.show(w, 'info');
      void modulesRef.current?.reload();
    } catch (e) {
      setPending(null);
      if (e instanceof ApiError && e.code === 'mandatory_fields' && e.missingMandatory.length) setMandatory(e.missingMandatory);
      else setActionError(e);
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

  const preview = (v: unknown) => {
    const t = typeof v === 'string' ? v.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() : v == null ? '' : String(v);
    return t.length > 90 ? `${t.slice(0, 90)}…` : t;
  };
  const primaryIdx = req.actions.findIndex(a => !/back|declin|reject/.test(a.action));
  const actionClass = (a: TransitionAction, i: number) =>
    i === primaryIdx ? 'btn-primary' : /declin|reject/.test(a.action) ? 'btn-danger-ghost' : 'btn-secondary';
  const blocked = editing || dataDirty;

  return (
    <div className="page page-request">
      {/* Summary band: the request at a glance in two lines, with the workflow actions */}
      <section className="req-band" aria-label="Request summary">
        <div className="rb-line1">
          <Link to="/requests" className="rb-back" aria-label="Back to credit requests" title="Credit requests"><span className="rtl-flip" aria-hidden="true">←</span></Link>
          <h1 className="rb-number">{req.requestNumber}</h1>
          <StatusBadge code={req.status} label={req.statusLabel} />
          <span className="rb-borrower" title={req.borrowerName}>{req.borrowerName}</span>
          <span className="rb-muted mono">{req.borrowerRef ?? 'New customer'}</span>
          <span className="rb-dot" aria-hidden="true">·</span>
          <span className="rb-muted">{ref.requestTypeLabel(req.requestType)}</span>
          <span className="grow" />
          {dataDirty && <span className="warn-text small rb-hint">Save or discard changes before an action</span>}
          {req.actions.map((a, i) => (
            <button key={a.action} type="button" className={`btn btn-sm ${actionClass(a, i)}`} onClick={() => setPending(a)} disabled={blocked}>{a.label}</button>
          ))}
          {canBook && <button type="button" className="btn btn-sm btn-primary" onClick={() => setBooking({ result: null })}>Book in {cbLabel.toLowerCase()}</button>}
          <details className="menu" ref={menuRef}>
            <summary className="btn btn-sm btn-secondary" aria-label="More actions">More <span aria-hidden="true">▾</span></summary>
            <div className="menu-list" role="menu">
              <button type="button" role="menuitem" onClick={() => { closeMenu(); setShowDetails(true); }}>{canEdit ? 'Edit request details' : 'Request details'}</button>
              {canPull && <button type="button" role="menuitem" onClick={() => { closeMenu(); void doPull(); }} disabled={pulling}>Refresh from bank systems</button>}
              <button type="button" role="menuitem" onClick={() => { closeMenu(); setShowHistory(true); }}>Workflow history ({history.length})</button>
              {hasRole('auditor', 'config_admin') && <button type="button" role="menuitem" onClick={() => { closeMenu(); navigate('/admin/audit'); }}>Audit trail</button>}
            </div>
          </details>
        </div>
        <dl className="rb-line2">
          <div><dt>Requested</dt><dd className="mono-num"><Amount value={req.requestedAmount} code={req.currencyCode} showCode={false} /> {req.currencyCode}</dd></div>
          {base && req.currencyCode !== base && <>
            <div><dt>Base</dt><dd className="mono-num"><Amount value={req.baseAmount} code={base} showCode={false} /> {base}</dd></div>
            <div><dt>FX rate</dt><dd className="mono-num">{trimDecimal(req.fxRateUsed)}</dd></div>
          </>}
          <div><dt>Authority</dt><dd>{ref.levelName(req.requiredLevel)} <span className="rb-muted">({req.requiredLevel})</span></dd></div>
          {(integ?.pulledAt || integ?.bookedAt || canPull) && (
            <div><dt>Bank data</dt><dd className="rb-cb">
              {pulling ? 'Refreshing…' : integ?.pulledAt ? <span title={`Read-only on the request. Pulled from\n${pulledFrom}`}>Pulled {formatDateTime(integ.pulledAt)} · {(integ.sources ?? []).filter(x => x.pulledAt).length} systems</span> : <span className="rb-muted">Not pulled</span>}
              {integ?.bookedAt && <span>· Booked {formatDateTime(integ.bookedAt)}</span>}
              {canPull && !pulling && <button type="button" className="link-btn small" onClick={doPull}>Refresh</button>}
            </dd></div>
          )}
          <div><dt>Updated</dt><dd>{formatDateTime(req.updatedAt)} <span className="rb-muted" title="Version">v{req.rowVersion}</span></dd></div>
          {formExtra.map(f => {
            const v = (req.fields as Record<string, unknown>)[f.key];
            const miss = missing.some(m => m.field === f.key);
            return (
              <div key={f.key} className="rb-text">
                <dt>{f.label}</dt>
                <dd>
                  {v ? <span title={typeof v === 'string' ? v : undefined}>{preview(v)}</span> : <span className={miss ? 'err-text' : 'rb-muted'}>{miss ? 'Required' : 'Not provided'}</span>}
                  <button type="button" className="link-btn small" onClick={() => setShowDetails(true)}>{canEdit ? 'Edit' : 'View'}</button>
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {warnings.length > 0 && <Alert tone="warning"><strong>Rule warnings</strong><ul>{warnings.map(w => <li key={w.rule + w.message}>{w.message} <span className="muted small">({w.rule})</span></li>)}</ul></Alert>}
      {actionError instanceof ApiError && actionError.isConflict ? (
        <Alert tone="warning" action={<button type="button" className="btn btn-secondary btn-sm" onClick={load}>Reload</button>}>
          This request was changed by someone else — Reload to see the latest version before acting.
        </Alert>
      ) : actionError ? (
        <Alert tone="error">{errorMessage(actionError)}{missing.length > 0 && <ul>{missing.map(m => <li key={m.field}>{ref.field(m.field)?.label ?? m.field}: {m.message}{formExtra.some(f => f.key === m.field) && canEdit && <> — <button type="button" className="link-btn small" onClick={() => setShowDetails(true)}>edit request details</button></>}</li>)}</ul>}</Alert>
      ) : null}

      <CreditRequestModules handle={modulesRef} requestId={req.id} header={{ borrowerName: req.borrowerName, borrowerRef: req.borrowerRef }}
        headerVersion={req.rowVersion} canEdit={hasRole('relationship_officer', 'credit_analyst')} onVersion={onVersion} onDirtyChange={setDataDirty} onIntegration={setInteg}
        navFooter={<>
          <button type="button" className="rn-extra" onClick={() => setShowHistory(true)}>Workflow history <span className="rn-count">{history.length}</span></button>
          {hasRole('auditor', 'config_admin') && <button type="button" className="rn-extra" onClick={() => navigate('/admin/audit')}>Audit trail</button>}
        </>} />

      {showDetails && (
        <Modal wide title={canEdit && !editing ? 'Request details' : canEdit ? 'Edit request details' : 'Request details'} onClose={() => { setShowDetails(false); setEditing(false); }}
          footer={!editing ? <>
            {canEdit && <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)} disabled={dataDirty}>Edit</button>}
            <button type="button" className="btn btn-primary" onClick={() => setShowDetails(false)}>Close</button>
          </> : undefined}>
          {editing ? (
            <RequestForm initial={req} submitLabel="Save changes" onCancel={() => setEditing(false)} onReload={() => { setEditing(false); setShowDetails(false); void load(); }}
              onSubmit={async input => {
                const res = await api.updateRequest(req.id, req.rowVersion, input);
                setReq(res.request); setWarnings(res.warnings); setEditing(false); setShowDetails(false); setActionError(null);
                toast.show(`${res.request.requestNumber} saved`, 'ok');
                return res.warnings;
              }} />
          ) : (
            <div className="form-2col">
              <ReadOnly label="Borrower name">{req.borrowerName}</ReadOnly>
              <ReadOnly label="Borrower reference">{req.borrowerRef ?? 'New customer — numbered by core banking at booking'}</ReadOnly>
              <ReadOnly label="Request type">{ref.requestTypeLabel(req.requestType)}</ReadOnly>
              <ReadOnly label="Currency">{req.currencyCode}{ref.currency(req.currencyCode) ? ` — ${ref.currency(req.currencyCode)!.name}` : ''}</ReadOnly>
              <ReadOnly label="Requested amount" mono><Amount value={req.requestedAmount} code={req.currencyCode} showCode={false} /></ReadOnly>
              <ReadOnly label={`Base amount${base ? ` (${base})` : ''}`} mono><Amount value={req.baseAmount} code={base} showCode={false} /></ReadOnly>
              <ReadOnly label="FX rate used" mono>{trimDecimal(req.fxRateUsed)}</ReadOnly>
              <ReadOnly label="Required authority level">{ref.levelName(req.requiredLevel)} ({req.requiredLevel})</ReadOnly>
              {layout && formExtra.map(f => (
                <FieldInput key={f.key} view meta={f} values={req.fields as Record<string, FormValue>} layout={layout} disabled
                  header={{ borrowerName: req.borrowerName, borrowerRef: req.borrowerRef }} onChange={() => undefined}
                  message={missing.find(m => m.field === f.key)?.message} />
              ))}
            </div>
          )}
        </Modal>
      )}
      {showHistory && (
        <Modal title={`Workflow history · ${req.requestNumber}`} onClose={() => setShowHistory(false)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setShowHistory(false)}>Close</button>}>
          <Timeline items={timeline} />
          <p className="muted small" style={{ marginBottom: 0 }}>Every change to this request is also recorded in the tamper-evident audit trail under <span className="icode">{req.requestNumber}</span>.</p>
        </Modal>
      )}
      {mandatory && <MissingFieldsModal missing={mandatory} layout={layout} onClose={() => setMandatory(null)}
        onGo={m => { setMandatory(null); modulesRef.current?.focusField(m); }} />}
      {pullResult && <PullResultModal result={pullResult} onClose={() => setPullResult(null)} />}
      {booking && <BookingModal label={cbLabel} requestNumber={req.requestNumber} result={booking.result} onConfirm={doBook} onClose={() => setBooking(null)} />}
      {pending && <TransitionModal action={pending} onCancel={() => setPending(null)} onConfirm={r => doTransition(pending, r)} />}
    </div>
  );
}
