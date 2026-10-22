import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage, type CatalogField, type Outcome, type RuleCatalog, type RuleRow, type WriteResult } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { formatDateTime } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ChangeStatus, ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { Badge, ScopeBadge } from '../components/Badge';
import { DataTable } from '../components/DataTable';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';
import {
  actionProblems, conditionProblems, DATE, DECIMAL, kindOf, newCondition, newGroup, nid, parseActions, parseCondition, serialiseActions,
  serialiseCondition, summarise, usedFields, type ActionNode, type GroupNode, type Names,
} from '../forms/ruleModel';
import { ActionsEditor, GroupEditor, useFieldOptions, type BuilderCtx } from '../forms/RuleBuilder';

interface Draft {
  key: string; isNew: boolean; scope: 'core' | 'tenant' | null; version: number | null;
  name: string; trigger: 'on_save' | 'on_submit'; active: boolean;
  root: GroupNode; actions: ActionNode[];
  /** Advanced mode: the stored JSON is edited directly (used when the builder cannot show a rule). */
  advanced: boolean; json: string; notice: string | null;
}

function blankDraft(key: string): Draft {
  return { key, isNew: true, scope: null, version: null, name: '', trigger: 'on_save', active: true,
    root: { ...newGroup('all'), items: [newCondition()] }, actions: [{ id: nid(), type: 'require', message: '' }], advanced: false, json: '', notice: null };
}

function fromRow(r: RuleRow): Draft {
  const condition = JSON.parse(r.conditionJson);
  const rawActions = JSON.parse(r.actionsJson);
  const root = parseCondition(condition);
  const actions = parseActions(rawActions);
  const json = JSON.stringify({ condition, actions: rawActions }, null, 2);
  const base = { key: r.ruleKey, isNew: false, scope: r.scope, version: r.rowVersion, name: r.name, trigger: r.triggerOn, active: r.isActive, json };
  if (!root || !actions) {
    return { ...base, root: newGroup('all'), actions: [], advanced: true,
      notice: 'This rule uses a condition the visual builder cannot show yet, so it is opened in the advanced editor. Nothing has been changed.' };
  }
  return { ...base, root, actions, advanced: false, notice: null };
}

/** Test inputs for the fields a rule reads, typed by kind. */
function TestPanel({ draft, catalog, names, canTest }: { draft: Draft; catalog: RuleCatalog; names: Names; canTest: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const keys = useMemo(() => {
    if (!draft.advanced) return usedFields(draft.root);
    const found = new Set<string>();
    draft.json.replace(/"var"\s*:\s*"([^"]+)"/g, (_m, k: string) => { found.add(k); return ''; });
    return [...found];
  }, [draft]);
  useEffect(() => { setOutcome(null); setError(null); }, [draft.key]);

  const run = async () => {
    setOutcome(null); setError(null);
    let condition: unknown; let actions: unknown;
    try {
      if (draft.advanced) ({ condition, actions } = JSON.parse(draft.json));
      else { condition = serialiseCondition(draft.root); actions = serialiseActions(draft.actions); }
    } catch (e) { setError(new Error(`The advanced JSON is not valid: ${errorMessage(e)}`)); return; }
    const record: Record<string, unknown> = {};
    for (const k of keys) {
      const raw = values[k] ?? '';
      const f = names.field(k);
      if (raw === '') continue;
      record[k] = kindOf(f) === 'bool' ? raw === 'true' : raw;
    }
    try { setOutcome(await api.testRule({ ruleKey: draft.key || 'TEST', name: draft.name || 'Test', condition, actions }, record)); }
    catch (e) { setError(e); }
  };

  const input = (f: CatalogField | undefined, k: string) => {
    const kind = kindOf(f);
    const v = values[k] ?? '';
    const set = (x: string) => { setValues({ ...values, [k]: x }); setOutcome(null); };
    if (kind === 'bool') return <select value={v} onChange={e => set(e.target.value)}><option value="">(empty)</option><option value="true">Yes</option><option value="false">No</option></select>;
    if (kind === 'date') return <input type="date" value={v} onChange={e => set(e.target.value)} />;
    if (kind === 'list') {
      return <select value={v} onChange={e => set(e.target.value)}><option value="">(empty)</option>{(catalog.lists[f!.list!] ?? []).map(e => <option key={e.code} value={e.code}>{e.label}</option>)}</select>;
    }
    return <input value={v} inputMode={kind === 'decimal' ? 'decimal' : undefined} placeholder={kind === 'decimal' ? 'e.g. 300000' : ''} onChange={e => set(e.target.value.trim())} />;
  };
  const bad = keys.filter(k => { const v = values[k]; const kind = kindOf(names.field(k)); return v && ((kind === 'decimal' && !DECIMAL.test(v)) || (kind === 'date' && !DATE.test(v))); });

  return (
    <section className="card" aria-labelledby="tester">
      <div className="card-head"><h3 id="tester">Try the rule</h3><span className="muted small">Nothing is saved</span></div>
      <div className="card-body">
        {keys.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Choose at least one field in “When” to try the rule.</p> : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>Enter example values for the fields this rule reads, then run it.</p>
            <div className="form-grid-4">
              {keys.map(k => { const f = names.field(k); return <Field key={k} label={f?.label ?? k}>{input(f, k)}</Field>; })}
            </div>
            {bad.length > 0 && <p className="field-error">Fix the highlighted example values (numbers as digits, dates as dates).</p>}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-primary" onClick={run} disabled={!canTest || bad.length > 0}>Run the rule</button>
              {!canTest && <span className="muted small" style={{ alignSelf: 'center' }}>Trying rules is available to configuration administrators.</span>}
            </div>
          </>
        )}
        <ErrorAlert error={error} />
        {outcome && (
          <div className={`test-result ${outcome.fired.length ? 'fired' : ''}`} role="status">
            {outcome.fired.length === 0 ? <p><strong>The rule does not apply</strong> to these values — nothing happens.</p> : (
              <>
                <p><strong>The rule applies.</strong> What the user would see:</p>
                <ul>
                  {outcome.blocks.map((b, i) => <li key={`b${i}`}><Badge tone="err">Blocked</Badge> {b.message}</li>)}
                  {outcome.warnings.map((w, i) => <li key={`w${i}`}><Badge tone="warn">Warning</Badge> {w.message}</li>)}
                  {outcome.required.map((r, i) => <li key={`r${i}`}><Badge tone="info">Required</Badge> {names.field(r.field)?.label ?? r.field} — {r.message}</li>)}
                  {outcome.hidden.map((h, i) => <li key={`h${i}`}><Badge tone="neutral">Hidden</Badge> {names.field(h)?.label ?? h}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function RulesPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Rules' }]);
  const { hasRole } = useAuth();
  const canEdit = hasRole('config_admin');
  const toast = useToast();
  const rules = useApi(() => api.rules(), []);
  const catalog = useApi(() => api.rulesCatalog(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!draft && rules.data?.[0]) open(rules.data[0]); }, [rules.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const cat = catalog.data;
  const byKey = useMemo(() => new Map((cat?.fields ?? []).map(f => [f.key, f])), [cat]);
  const names: Names = useMemo(() => ({
    field: k => byKey.get(k), param: k => cat?.parameters.find(p => p.key === k), list: k => cat?.lists[k],
  }), [byKey, cat]);
  const fieldOptions = useFieldOptions(cat);
  const requireOptions = useFieldOptions(cat, f => f.group !== 'Request');

  function open(r: RuleRow) { setDraft(fromRow(r)); setShowProblems(false); setSaveError(null); setResult(null); }
  const startNew = () => {
    const n = (rules.data ?? []).filter(r => r.scope === 'tenant').length + 1;
    setDraft(blankDraft(`R-${String(n).padStart(3, '0')}`)); setShowProblems(false); setSaveError(null); setResult(null);
  };
  const patch = (p: Partial<Draft>) => { setDraft(d => (d ? { ...d, ...p } : d)); setResult(null); };

  const problems = useMemo(() => {
    if (!draft || draft.advanced) return new Map<string, string>();
    const m = conditionProblems(draft.root, names);
    actionProblems(draft.actions).forEach((v, k) => m.set(k, v));
    return m;
  }, [draft, names]);

  const save = async () => {
    if (!draft) return;
    setShowProblems(true);
    if (!draft.name.trim() || !/^[A-Za-z0-9_.-]+$/.test(draft.key)) return;
    let condition: object; let actions: unknown[];
    if (draft.advanced) {
      try { ({ condition, actions } = JSON.parse(draft.json)); } catch (e) { setSaveError(new Error(`The advanced JSON is not valid: ${errorMessage(e)}`)); return; }
    } else {
      if (problems.size || draft.actions.length === 0) return;
      condition = serialiseCondition(draft.root) as object; actions = serialiseActions(draft.actions);
    }
    setBusy(true); setSaveError(null); setResult(null);
    try {
      const r = await api.saveRule(draft.key, { name: draft.name.trim(), entityType: 'credit_request', triggerOn: draft.trigger, condition, actions, isActive: draft.active,
        ...(draft.scope === 'tenant' && draft.version !== null ? { expectedVersion: draft.version } : {}) });
      setResult(r); toast.configResult(r, `Rule ${draft.key} saved`);
      if (r.status === 'applied') await rules.reload();
    } catch (e) { setSaveError(e); } finally { setBusy(false); }
  };

  const toAdvanced = () => {
    if (!draft) return;
    const json = draft.advanced ? draft.json : JSON.stringify({ condition: serialiseCondition(draft.root), actions: serialiseActions(draft.actions) }, null, 2);
    patch({ advanced: true, json, notice: null });
  };
  const backToBuilder = () => {
    if (!draft) return;
    try {
      const { condition, actions } = JSON.parse(draft.json);
      const root = parseCondition(condition); const acts = parseActions(actions);
      if (!root || !acts) { patch({ notice: 'The builder cannot show this condition. Keep editing it here, or simplify it.' }); return; }
      patch({ advanced: false, root, actions: acts, notice: null });
    } catch (e) { patch({ notice: `The JSON is not valid: ${errorMessage(e)}` }); }
  };

  const disabled = !canEdit || busy;
  const ctx: BuilderCtx | null = cat ? { catalog: cat, field: k => byKey.get(k), fieldOptions, disabled, problems: showProblems ? problems : new Map() } : null;
  const summary = draft && !draft.advanced && cat ? summarise(draft.root, draft.actions, names) : null;

  return (
    <div className="page">
      <PageHead title="Rules" subtitle="Checks that run when a credit request is saved or submitted — built from fields, settings and actions, no code."
        actions={canEdit ? <button type="button" className="btn btn-primary" onClick={startNew}>+ New rule</button> : undefined} />
      <section className="card" aria-label="Rules in force" style={{ marginBottom: 18 }}>
        {rules.error ? <div className="pad"><ErrorAlert error={rules.error} onReload={rules.reload} /></div> : !rules.data ? <Spinner /> : (
          <DataTable rows={rules.data} rowKey={r => r.id} caption="Rules" onRowClick={open} rowLabel={r => `Open rule ${r.ruleKey}`}
            rowClass={r => (draft?.key === r.ruleKey && !draft.isNew ? 'expanded' : undefined)} empty="No rules yet. Create the first one with “+ New rule”."
            columns={[
              { key: 'k', header: 'Rule', cell: r => <span className="strong mono">{r.ruleKey}</span> },
              { key: 'n', header: 'Name', cell: r => r.name },
              { key: 't', header: 'Checked', cell: r => r.triggerOn === 'on_save' ? 'On save' : 'On submission' },
              { key: 's', header: 'Scope', cell: r => <ScopeBadge scope={r.scope} /> },
              { key: 'a', header: 'Status', cell: r => r.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Inactive</Badge> },
              { key: 'u', header: 'Updated', hideSm: true, cell: r => <span className="small muted nowrap">{formatDateTime(r.updatedAt)}</span> },
            ]} />
        )}
      </section>

      {catalog.error ? <ErrorAlert error={catalog.error} onReload={catalog.reload} /> : !draft || !ctx ? (rules.data && <Spinner />) : (
        <div className="rule-editor">
          <section className="card" aria-labelledby="rule-head">
            <div className="card-head">
              <h3 id="rule-head">{draft.isNew ? 'New rule' : <>Rule <span className="mono">{draft.key}</span></>}</h3>
              {draft.scope && <ScopeBadge scope={draft.scope} />}
            </div>
            <div className="card-body">
              <ChangeStatus result={result} what="The rule" />
              {saveError instanceof ApiError && saveError.status === 422 ? <Alert tone="error">{errorMessage(saveError)}</Alert> : <ErrorAlert error={saveError} onReload={rules.reload} />}
              {draft.scope === 'core' && canEdit && <Alert tone="info">This rule comes with Creditum. Saving it creates your workspace’s own version with the same ID; other workspaces keep the original.</Alert>}

              <div className="form-grid-4">
                {draft.isNew && (
                  <Field label="Rule ID" required error={showProblems && !/^[A-Za-z0-9_.-]+$/.test(draft.key) ? 'Letters, digits, "-", "_" and "." only' : undefined} help="A short reference, e.g. XYZ-010">
                    <input value={draft.key} onChange={e => patch({ key: e.target.value.trim() })} disabled={disabled} className="mono" />
                  </Field>
                )}
                <Field label="Name" required wide error={showProblems && !draft.name.trim() ? 'Give the rule a name people will recognise' : undefined}>
                  <input value={draft.name} onChange={e => patch({ name: e.target.value })} disabled={disabled} maxLength={250} placeholder="e.g. Purpose code required for large new facilities" />
                </Field>
                <Field label="When to check">
                  <select value={draft.trigger} onChange={e => patch({ trigger: e.target.value as Draft['trigger'] })} disabled={disabled}>
                    <option value="on_save">On save</option><option value="on_submit">On submission</option>
                  </select>
                </Field>
                <div className="field"><span className="field-label">Status</span>
                  <label className="switch" style={{ minHeight: 40 }}><input type="checkbox" checked={draft.active} disabled={disabled} onChange={e => patch({ active: e.target.checked })} /><span>{draft.active ? 'Active' : 'Inactive'}</span></label>
                </div>
              </div>

              {draft.notice && <Alert tone="warning">{draft.notice}</Alert>}
              {!draft.advanced && (
                <>
                  <h4 className="builder-head">When</h4>
                  <p className="muted small builder-help">Pick a field, how to compare it, and a value — or a setting, so each bank can set its own limit.</p>
                  <GroupEditor group={draft.root} ctx={ctx} onChange={root => patch({ root })} />
                  <h4 className="builder-head">Then</h4>
                  <ActionsEditor actions={draft.actions} ctx={ctx} requireOptions={requireOptions} onChange={actions => patch({ actions })} />
                  {showProblems && draft.actions.length === 0 && <p className="field-error">Add at least one action.</p>}
                  {draft.trigger === 'on_save' && draft.actions.some(a => a.type === 'require' && a.field && byKey.get(a.field)?.group !== 'Request') && (
                    <Alert tone="info">This rule is checked <strong>on save</strong> and requires a field from the request’s modules. A new request is first saved from the
                      header form, which does not include that field — so a matching request could not be created at all. Usually <strong>On submission</strong> is what you want:
                      drafts save freely and the field is required before the request moves on.
                      <div style={{ marginTop: 8 }}><button type="button" className="btn btn-secondary btn-sm" onClick={() => patch({ trigger: 'on_submit' })} disabled={disabled}>Check on submission instead</button></div>
                    </Alert>
                  )}
                  <div className="rule-summary" aria-live="polite"><span className="field-label">In plain words</span><p>{summary}</p></div>
                </>
              )}

              <details className="advanced" open={draft.advanced} onToggle={e => { if ((e.target as HTMLDetailsElement).open && !draft.advanced) toAdvanced(); }}>
                <summary>Advanced (developers)</summary>
                {draft.advanced ? (
                  <>
                    <p className="muted small">The rule as stored: <span className="mono">{'{ "condition": …, "actions": [ … ] }'}</span>. Operators: var, cfg, and, or, not, ==, !=, &gt;, &gt;=, &lt;, &lt;=, in, empty.</p>
                    <label htmlFor="rule-json" className="sr-only">Rule JSON</label>
                    <textarea id="rule-json" className="json-edit" rows={14} value={draft.json} disabled={disabled} spellCheck={false} onChange={e => patch({ json: e.target.value })} />
                    <div className="btn-row" style={{ marginTop: 8 }}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={backToBuilder}>Back to the visual builder</button>
                    </div>
                  </>
                ) : <p className="muted small">Opening this switches to the JSON editor.</p>}
              </details>
            </div>
            {canEdit && (
              <div className="form-foot">
                {showProblems && problems.size > 0 && <span className="grow err-text small">Complete the highlighted parts of the rule.</span>}
                <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : draft.scope === 'core' ? 'Save as workspace rule' : 'Save rule'}</button>
              </div>
            )}
          </section>
          <TestPanel draft={draft} catalog={cat!} names={names} canTest={canEdit} />
        </div>
      )}
    </div>
  );
}
