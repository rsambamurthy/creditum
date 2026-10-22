import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage, type WfDefinition, type WfTransition } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { useReference } from '../reference';
import { formatDateTime, humanize } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { ErrorAlert, Loadable, PageHead } from '../components/Feedback';
import { Badge } from '../components/Badge';
import { DataTable } from '../components/DataTable';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';

function StateFlow({ def }: { def: WfDefinition }) {
  return (
    <div className="flow" role="list" aria-label="Workflow states">
      {def.states.map((s, i) => (
        <Fragment key={s.code}>
          {i > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
          <div role="listitem" className={`flow-chip${s.code === def.initial ? ' initial' : ''}${s.editable ? ' editable' : ''}${s.final ? ` final${/declin|reject|cancel/.test(s.code) ? ' neg' : ''}` : ''}`}>
            <span className="fc-l">{s.label}</span>
            <span className="fc-c mono">{s.code}</span>
            <span className="fc-tags">
              {s.code === def.initial && <span className="flag on">Initial</span>}
              {s.editable && <span className="flag">Editable</span>}
              {s.final && <span className="flag">Final</span>}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function TransitionTable({ def }: { def: WfDefinition }) {
  const label = (code: string) => def.states.find(s => s.code === code)?.label ?? code;
  const flag = (on: boolean | undefined, text: string, title: string) => <span className={`flag${on ? ' on' : ''}`} title={title}>{on ? text : '—'}</span>;
  return (
    <DataTable<WfTransition> rows={def.transitions} rowKey={t => `${t.from}|${t.action}`} caption="Transitions" columns={[
      { key: 'a', header: 'Action', cell: t => <><div className="strong">{t.label}</div><div className="muted small mono">{t.action}</div></> },
      { key: 'ft', header: 'From → to', cell: t => <span className="nowrap">{label(t.from)} <span className="rtl-flip muted" aria-hidden="true">→</span><span className="sr-only">to</span> {label(t.to)}</span> },
      { key: 'r', header: 'Roles', cell: t => <span className="role-list">{t.roles.map(r => <Badge key={r} tone="neutral">{humanize(r)}</Badge>)}</span> },
      { key: 'c', header: 'Checker', cell: t => flag(t.checker, 'Not maker', 'The maker of the request cannot perform this step') },
      { key: 'au', header: 'Authority', cell: t => flag(t.authority, 'Required', 'The actor must hold the required delegated authority level or higher') },
      { key: 'rm', header: 'Remarks', cell: t => flag(t.remarksRequired, 'Required', 'Remarks must be entered') },
    ]} />
  );
}

function Editor({ requestType, def, version, onSaved }: { requestType: string; def: WfDefinition; version: number; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(JSON.stringify(def, null, 2));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(JSON.stringify(def, null, 2)); setError(null); }, [def]);
  const save = async () => {
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { setError(new Error(`The definition is not valid JSON: ${errorMessage(e)}`)); return; }
    setBusy(true);
    try {
      toast.configResult(await api.saveWorkflow(requestType, parsed, version), `Workflow for ${requestType} saved`);
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="wf-edit" style={{ marginTop: 16 }}>
      <div className="card-head"><h3 id="wf-edit">Edit definition</h3><span className="muted small">Validated by the server: every state defined, reachable, each transition with a label and roles</span></div>
      <div className="card-body stack">
        <Field label="Workflow definition (JSON)">
          <textarea className="json-edit tall" value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        </Field>
        <ErrorAlert error={error} onReload={onSaved} />
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Submitting…' : 'Validate and save'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => { setText(JSON.stringify(def, null, 2)); setError(null); }} disabled={busy}>Reset</button>
        </div>
      </div>
    </section>
  );
}

export function WorkflowsPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Workflows' }]);
  const { hasRole } = useAuth();
  const ref = useReference();
  const list = useApi(() => api.workflows(), []);
  const [params, setParams] = useSearchParams();
  const current = params.get('type') ?? list.data?.[0]?.requestType ?? '';
  const detail = useApi(() => (current ? api.workflow(current) : Promise.reject(new Error('No workflow selected'))), [current]);

  return (
    <div className="page">
      <PageHead title="Workflows" subtitle="Per request type: the states a credit request moves through and who may move it." />
      <Loadable state={list}>{rows => (
        <section className="card">
          <div className="tabs" role="tablist" aria-label="Request types">
            {rows.map(w => (
              <button key={w.requestType} type="button" role="tab" aria-selected={w.requestType === current} className={w.requestType === current ? 'active' : ''}
                onClick={() => setParams({ type: w.requestType }, { replace: true })}>{ref.requestTypeLabel(w.requestType)}</button>
            ))}
          </div>
          <div role="tabpanel" style={{ padding: 18 }}>
            <Loadable state={detail}>{d => (
              <>
                <div className="row-between" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                  <div><span className="strong">{ref.requestTypeLabel(d.requestType)}</span> <span className="icode">{d.requestType}</span></div>
                  <span className="muted small">Version {d.rowVersion} · updated {formatDateTime(d.updatedAt)}</span>
                </div>
                <p className="sub-head">States</p>
                <StateFlow def={d.definition} />
                <p className="sub-head" style={{ marginTop: 18 }}>Transitions</p>
                <div className="card" style={{ overflow: 'hidden' }}><TransitionTable def={d.definition} /></div>
                {hasRole('config_admin') && <Editor requestType={d.requestType} def={d.definition} version={d.rowVersion} onSaved={() => { void detail.reload(); }} />}
              </>
            )}</Loadable>
          </div>
        </section>
      )}</Loadable>
    </div>
  );
}
