import { useEffect, useState } from 'react';
import { api, errorMessage, type Outcome, type RuleRow } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { formatDateTime, prettyJson } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ErrorAlert, Loadable, PageHead } from '../components/Feedback';
import { Badge, ScopeBadge } from '../components/Badge';
import { DataTable } from '../components/DataTable';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';

const SAMPLE_RECORD = { borrower_name: 'Sample Trading Co.', request_type: 'new', requested_amount: '300000', base_amount: '300000' };
const NEW_RULE = { ruleKey: 'T-001', name: 'New workspace rule', condition: { '>': [{ var: 'base_amount' }, { cfg: 'credit_request.narrative_required_above' }] },
  actions: [{ type: 'warn', message: 'Describe the message shown to the user' }] };

function parseJson(text: string, what: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: `${what} is not valid JSON: ${errorMessage(e)}` }; }
}

function ruleJson(r: RuleRow) {
  return JSON.stringify({ ruleKey: r.ruleKey, name: r.name, condition: JSON.parse(r.conditionJson), actions: JSON.parse(r.actionsJson) }, null, 2);
}

function OutcomeView({ o }: { o: Outcome }) {
  const box = (title: string, items: string[], tone: string) => (
    <div><h4>{title}<span className={tone}>{items.length}</span></h4>{items.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="muted small">None</span>}</div>
  );
  return (
    <div className="outcome" aria-live="polite">
      {box('Blocks', o.blocks.map(b => b.message), o.blocks.length ? 'err-text' : '')}
      {box('Warnings', o.warnings.map(w => w.message), o.warnings.length ? 'warn-text' : '')}
      {box('Required', o.required.map(r => `${r.field} — ${r.message}`), '')}
      {box('Fired', o.fired, o.fired.length ? 'ok-text' : '')}
    </div>
  );
}

export function RulesPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Rules' }]);
  const { hasRole } = useAuth();
  const canEdit = hasRole('config_admin');
  const toast = useToast();
  const state = useApi(() => api.rules(), []);
  const [selected, setSelected] = useState<RuleRow | null>(null);
  const [ruleText, setRuleText] = useState(JSON.stringify(NEW_RULE, null, 2));
  const [recordText, setRecordText] = useState(JSON.stringify(SAMPLE_RECORD, null, 2));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const [trigger, setTrigger] = useState<'on_save' | 'on_submit'>('on_save');
  const [active, setActive] = useState(true);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!selected && state.data?.[0]) pick(state.data[0]); }, [state.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(r: RuleRow) {
    setSelected(r); setRuleText(ruleJson(r)); setTrigger(r.triggerOn); setActive(r.isActive); setOutcome(null); setTestError(null); setSaveError(null);
  }

  const runTest = async () => {
    setOutcome(null); setTestError(null);
    const rule = parseJson(ruleText, 'Rule'); if (!rule.ok) { setTestError(new Error(rule.error)); return; }
    const rec = parseJson(recordText, 'Sample record'); if (!rec.ok) { setTestError(new Error(rec.error)); return; }
    if (typeof rec.value !== 'object' || rec.value === null || Array.isArray(rec.value)) { setTestError(new Error('The sample record must be a JSON object')); return; }
    try { setOutcome(await api.testRule(rule.value, rec.value as Record<string, unknown>)); } catch (e) { setTestError(e); }
  };

  const save = async () => {
    setSaveError(null);
    const parsed = parseJson(ruleText, 'Rule'); if (!parsed.ok) { setSaveError(new Error(parsed.error)); return; }
    const r = parsed.value as { ruleKey?: string; name?: string; condition?: object; actions?: unknown[] };
    if (!r.ruleKey || !/^[A-Za-z0-9_.-]+$/.test(r.ruleKey)) { setSaveError(new Error('The rule needs a "ruleKey" (letters, digits, "-", "_", ".")')); return; }
    const existingTenant = state.data?.find(x => x.ruleKey === r.ruleKey && x.scope === 'tenant');
    setBusy(true);
    try {
      const res = await api.saveRule(r.ruleKey, { name: r.name ?? '', entityType: 'credit_request', triggerOn: trigger, condition: r.condition ?? {},
        actions: r.actions ?? [], isActive: active, ...(existingTenant ? { expectedVersion: existingTenant.rowVersion } : {}) });
      toast.configResult(res, `Rule ${r.ruleKey} saved for this workspace`);
      await state.reload();
    } catch (e) { setSaveError(e); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <PageHead title="Rules" subtitle="Condition → action rules stored as data. Thresholds are read from configuration, so one rule serves every workspace."
        actions={canEdit ? <button type="button" className="btn btn-secondary" onClick={() => { setSelected(null); setRuleText(JSON.stringify(NEW_RULE, null, 2)); setTrigger('on_save'); setActive(true); setOutcome(null); }}>+ New workspace rule</button> : undefined} />
      <section className="card" aria-label="Rules in force" style={{ marginBottom: 16 }}>
        <Loadable state={state}>{rows => (
          <DataTable rows={rows} rowKey={r => r.id} caption="Rules" onRowClick={pick} rowLabel={r => `Open rule ${r.ruleKey}`}
            rowClass={r => (selected?.id === r.id ? 'expanded' : undefined)} columns={[
              { key: 'k', header: 'Key', cell: r => <span className="strong mono">{r.ruleKey}</span> },
              { key: 'n', header: 'Name', cell: r => r.name },
              { key: 't', header: 'Trigger', cell: r => <Badge tone="neutral">{r.triggerOn === 'on_save' ? 'On save' : 'On submit'}</Badge> },
              { key: 's', header: 'Scope', cell: r => <ScopeBadge scope={r.scope} /> },
              { key: 'a', header: 'Active', cell: r => r.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Inactive</Badge> },
              { key: 'u', header: 'Updated', hideSm: true, cell: r => <span className="small muted nowrap">{formatDateTime(r.updatedAt)} · v{r.rowVersion}</span> },
            ]} empty="No rules are defined." />
        )}</Loadable>
      </section>

      <div className="two-col">
        <section className="card" aria-labelledby="rule-def">
          <div className="card-head"><h3 id="rule-def">{selected ? <>Rule {selected.ruleKey}</> : 'New rule'}</h3>{selected && <ScopeBadge scope={selected.scope} />}</div>
          <div className="card-body stack">
            {selected && <>
              <p className="sub-head">Condition</p>
              <pre className="code">{prettyJson(selected.conditionJson)}</pre>
              <p className="sub-head">Actions</p>
              <pre className="code">{prettyJson(selected.actionsJson)}</pre>
              {selected.scope === 'core' && canEdit && <Alert tone="info">This is a core-library rule. Saving it here creates a workspace rule with the same key that replaces it for this workspace only.</Alert>}
            </>}
            {!selected && <p className="muted small" style={{ margin: 0 }}>Write the rule in the editor, test it, then save it as a workspace rule.</p>}
          </div>
        </section>

        <section className="card" aria-labelledby="tester">
          <div className="card-head"><h3 id="tester">Rule tester</h3><span className="muted small">Nothing is saved when testing</span></div>
          <div className="card-body stack">
            <Field label="Rule (JSON)" help='{"ruleKey", "name", "condition", "actions"} — operators: var, cfg, and, or, not, ==, !=, >, >=, <, <=, in, empty'>
              <textarea className="json-edit" value={ruleText} onChange={e => setRuleText(e.target.value)} spellCheck={false} rows={12} />
            </Field>
            <Field label="Sample record (JSON)" help="Amounts as decimal strings, e.g. &quot;base_amount&quot;: &quot;300000&quot;">
              <textarea className="json-edit" value={recordText} onChange={e => setRecordText(e.target.value)} spellCheck={false} rows={7} />
            </Field>
            {canEdit ? (
              <div className="btn-row"><button type="button" className="btn btn-primary" onClick={runTest}>Run test</button></div>
            ) : <p className="muted small" style={{ margin: 0 }}>Testing and saving rules is available to configuration administrators.</p>}
            <ErrorAlert error={testError} />
            {outcome && <OutcomeView o={outcome} />}
            {canEdit && (
              <>
                <p className="sub-head">Save as workspace rule</p>
                <div className="field-grid">
                  <Field label="Trigger">
                    <select value={trigger} onChange={e => setTrigger(e.target.value as 'on_save' | 'on_submit')}><option value="on_save">On save</option><option value="on_submit">On submit</option></select>
                  </Field>
                  <div className="field"><span className="field-label">Status</span><label className="checkbox" style={{ minHeight: 40 }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Active</label></div>
                </div>
                <ErrorAlert error={saveError} onReload={state.reload} />
                <div className="btn-row"><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save workspace rule'}</button></div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
