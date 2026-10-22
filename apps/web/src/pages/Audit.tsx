import { Fragment, useEffect, useState } from 'react';
import { api, type AuditEvent, type VerifyResult } from '../api';
import { formatDateTime, humanize, prettyJson, shortHash } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { Badge } from '../components/Badge';

const PAGE = 100;

export function AuditPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Audit Trail' }]);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<unknown>(null);

  const load = async () => {
    setError(null);
    try { const r = await api.audit(PAGE); setEvents(r); setMore(r.length === PAGE); } catch (e) { setError(e); }
  };
  useEffect(() => { void load(); }, []);

  const loadOlder = async () => {
    if (!events?.length) return;
    setLoadingMore(true);
    try {
      const r = await api.audit(PAGE, events[events.length - 1].seq);
      setEvents([...events, ...r]); setMore(r.length === PAGE);
    } catch (e) { setError(e); } finally { setLoadingMore(false); }
  };

  const runVerify = async () => {
    setVerifying(true); setVerifyError(null);
    try { setVerify(await api.verifyAudit()); } catch (e) { setVerifyError(e); } finally { setVerifying(false); }
  };

  return (
    <div className="page">
      <PageHead title="Audit Trail" subtitle="Append-only, hash-chained record of every business and configuration change in this workspace."
        actions={<button type="button" className="btn btn-primary" onClick={runVerify} disabled={verifying}>{verifying ? 'Verifying…' : 'Verify chain'}</button>} />

      <ErrorAlert error={verifyError} />
      {verify && (
        <div className={`action-bar`} role="status" style={verify.valid ? undefined : { borderInlineStartColor: 'var(--err)' }}>
          <div className="verify-box">
            {verify.valid ? <Badge tone="ok">Chain valid</Badge> : <Badge tone="err">Chain broken</Badge>}
            <span><strong className="mono-num">{verify.checked}</strong> record{verify.checked === 1 ? '' : 's'} checked</span>
            {!verify.valid && verify.brokenAtSeq !== undefined && <span>First break at sequence <strong className="mono-num">{String(verify.brokenAtSeq)}</strong></span>}
            {!verify.valid && verify.reason && <span className="err-text">{verify.reason}</span>}
          </div>
          <span className="muted small">Verified {formatDateTime(new Date().toISOString())}</span>
        </div>
      )}

      <section className="card" aria-label="Audit events">
        {error ? <div className="pad"><ErrorAlert error={error} onReload={load} /></div> : !events ? <Spinner /> : (
          <>
            <div className="table-wrap">
              <table className="table static">
                <caption className="sr-only">Audit events, newest first</caption>
                <thead><tr>
                  <th scope="col" className="num">Seq</th><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th>
                  <th scope="col">Entity</th><th scope="col">Reference</th><th scope="col" className="hide-sm">Hash</th><th scope="col"><span className="sr-only">Details</span></th>
                </tr></thead>
                <tbody>
                  {events.length === 0 && <tr className="no-hover"><td colSpan={8}><div className="empty">No audit events.</div></td></tr>}
                  {events.map(e => {
                    const isOpen = open === e.id;
                    return (
                      <Fragment key={e.id}>
                        <tr className={isOpen ? 'expanded' : undefined}>
                          <td className="num">{String(e.seq)}</td>
                          <td className="nowrap small">{formatDateTime(e.occurredAtUtc)}</td>
                          <td>{e.actorName}</td>
                          <td><span className="strong">{humanize(e.action)}</span></td>
                          <td><Badge tone="neutral">{humanize(e.entityType)}</Badge></td>
                          <td className="clip"><span className="icode">{e.entityRef}</span></td>
                          <td className="hide-sm"><span className="hash" title={e.hash}>{shortHash(e.hash)}</span></td>
                          <td className="actions">
                            <button type="button" className="link-btn small" aria-expanded={isOpen} aria-controls={`ad-${e.id}`} onClick={() => setOpen(isOpen ? null : e.id)}>
                              {isOpen ? 'Hide' : 'Details'}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="detail-row" id={`ad-${e.id}`}>
                            <td colSpan={8}>
                              <div className="diff-cols">
                                <div><p className="sub-head">Before</p>{e.beforeData ? <pre className="code light">{prettyJson(e.beforeData)}</pre> : <p className="muted small">—</p>}</div>
                                <div><p className="sub-head">After</p>{e.afterData ? <pre className="code light">{prettyJson(e.afterData)}</pre> : <p className="muted small">—</p>}</div>
                              </div>
                              <dl className="facts" style={{ marginTop: 10 }}>
                                <div><dt>Record hash</dt><dd className="hash break">{e.hash}</dd></div>
                                <div><dt>Previous hash</dt><dd className="hash break">{e.prevHash}</dd></div>
                                <div><dt>Session</dt><dd className="hash">{e.sessionRef ?? '—'}</dd></div>
                                <div><dt>Client IP</dt><dd className="hash">{e.clientIp ?? '—'}</dd></div>
                              </dl>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span className="muted small">{events.length} event{events.length === 1 ? '' : 's'} loaded, newest first</span>
              {more ? <button type="button" className="btn btn-secondary btn-sm" onClick={loadOlder} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older events'}</button>
                : <span className="muted small">Start of the chain reached</span>}
            </div>
          </>
        )}
      </section>
      <Alert tone="info">The audit trail cannot be edited from the application. “Verify chain” recomputes every record’s hash in sequence and reports the first break.</Alert>
    </div>
  );
}
