import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type EffectiveField } from '../api';
import { useAuth } from '../auth';
import { useReference } from '../reference';
import { useDebounced } from '../hooks';
import { useCrumbs } from '../layout/crumbs';
import { ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { StatTiles } from '../components/StatTiles';
import { OriginChip, RequirementBadge, ScopeBadge } from '../components/Badge';
import { DataTable, Pager, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';

const PAGE = 50;
/** Requirement values accepted by the registry (validated again by the API). */
const REQUIREMENTS = ['Mandatory', 'Conditional', 'Optional', 'System-populated'];
/** Data types a tenant custom field can use (typed extension storage; validated again by the API). */
const CUSTOM_TYPES = ['Text', 'Rich Text', 'Text (identifier)', 'Dropdown', 'Currency Code', 'Currency Amount', 'Percentage', 'Ratio (decimal)',
  'Decimal', 'Integer', 'Date', 'Boolean (Yes/No)'];

function uniq(xs: string[]) { return [...new Set(xs)].sort((a, b) => a.localeCompare(b)); }

function FieldDetail({ f, canEdit, onClose, onSaved }: { f: EffectiveField; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState(f.label !== f.coreLabel ? f.label : '');
  const [requirement, setRequirement] = useState(f.requirement !== f.coreRequirement ? f.requirement : '');
  const [hidden, setHidden] = useState(f.hidden);
  const [helpText, setHelpText] = useState(f.helpText ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.overrideField(f.fieldKey, {
        labelOverride: label.trim() || undefined, requirementOverride: requirement || undefined, hidden, helpText: helpText.trim() || undefined,
        ...(f.overrideVersion !== null ? { expectedVersion: f.overrideVersion } : {}),
      });
      toast.configResult(r, `Override saved for ${f.libraryId}`);
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const facts: [string, ReactNode][] = [
    ['Field key', <span className="icode">{f.fieldKey}</span>], ['Library ID', f.libraryId], ['Module', f.module], ['Group', f.group],
    ['Label', <>{f.label}{f.label !== f.coreLabel && <span className="muted small"> (core: {f.coreLabel})</span>}</>],
    ['Data type', f.dataType], ['Source', f.source], ['Adapter', f.adapter ?? '—'],
    ['Requirement', <><RequirementBadge value={f.requirement} />{f.requirement !== f.coreRequirement && <span className="muted small"> (core: {f.coreRequirement})</span>}</>],
    ['Hidden', f.hidden ? 'Yes' : 'No'], ['Help text', f.helpText ?? '—'], ['Origin', <OriginChip origin={f.origin} />], ['Scope', <ScopeBadge scope={f.scope} />],
    ['Override', f.overrideVersion !== null ? `Workspace override, version ${f.overrideVersion}` : 'None'],
  ];

  return (
    <Modal wide title={<>{f.libraryId} · {f.label}</>} onClose={onClose}
      footer={canEdit ? <>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        <button type="submit" form="ov-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save override'}</button>
      </> : <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>}>
      <div className="two-col">
        <div>
          <p className="sub-head">Metadata</p>
          <dl className="facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <p className="sub-head">Configurable elements</p>
          {f.configurable ? <p className="text-block">{f.configurable}</p> : <p className="muted small">None recorded.</p>}
          <p className="sub-head">Review notes</p>
          {f.reviewNotes ? <p className="text-block">{f.reviewNotes}</p> : <p className="muted small">None.</p>}
        </div>
        <div>
          <p className="sub-head">Workspace override</p>
          {!canEdit ? <p className="muted small">Only configuration administrators can change how this field appears in your workspace.</p> : (
            <form id="ov-form" onSubmit={save} className="stack">
              <ErrorAlert error={error} />
              <Field label="Label override" help={`Leave empty to use the core label “${f.coreLabel}”.`}>
                <input value={label} onChange={e => setLabel(e.target.value)} maxLength={250} placeholder={f.coreLabel} />
              </Field>
              <Field label="Requirement override">
                <select value={requirement} onChange={e => setRequirement(e.target.value)}>
                  <option value="">Use core requirement ({f.coreRequirement})</option>
                  {REQUIREMENTS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <label className="checkbox"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Hide this field in the workspace</label>
              <Field label="Help text" help="Shown under the field on forms.">
                <textarea rows={3} value={helpText} onChange={e => setHelpText(e.target.value)} maxLength={500} />
              </Field>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CustomFieldModal({ modules, groups, onClose, onSaved }: { modules: string[]; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('x.');
  const [label, setLabel] = useState('');
  const [module, setModule] = useState(modules[0] ?? '');
  const [group, setGroup] = useState('');
  const [dataType, setDataType] = useState(CUSTOM_TYPES[0]);
  const [requirement, setRequirement] = useState('Optional');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!/^x\.[a-z0-9_.]+$/.test(key)) er.key = 'Start with "x." and use lower-case letters, digits, "_" and "."';
    if (!label.trim()) er.label = 'Enter a label';
    if (!module.trim()) er.module = 'Choose a module';
    if (!group.trim()) er.group = 'Enter a group';
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true); setError(null);
    try {
      const r = await api.customField(key, { label: label.trim(), module: module.trim(), group: group.trim(), dataType, requirement });
      toast.configResult(r, `Custom field ${key} added`);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') setErrors({ key: err.message }); else setError(err);
    } finally { setBusy(false); }
  };

  return (
    <Modal title="New custom field" onClose={onClose} footer={<>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button type="submit" form="cf-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add field'}</button>
    </>}>
      <form id="cf-form" onSubmit={save} className="field-grid" noValidate>
        <div className="field-wide"><ErrorAlert error={error} /></div>
        <Field label="Field key" required error={errors.key} help='Workspace fields start with "x.", e.g. x.borrower.sector_code'>
          <input value={key} onChange={e => setKey(e.target.value)} className="ltr mono" spellCheck={false} />
        </Field>
        <Field label="Label" required error={errors.label}><input value={label} onChange={e => setLabel(e.target.value)} maxLength={250} /></Field>
        <Field label="Module" required error={errors.module}>
          <select value={module} onChange={e => setModule(e.target.value)}>{modules.map(m => <option key={m}>{m}</option>)}</select>
        </Field>
        <Field label="Group" required error={errors.group}>
          <input value={group} onChange={e => setGroup(e.target.value)} list="cf-groups" />
        </Field>
        <datalist id="cf-groups">{groups.map(g => <option key={g} value={g} />)}</datalist>
        <Field label="Data type"><select value={dataType} onChange={e => setDataType(e.target.value)}>{CUSTOM_TYPES.map(t => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Requirement"><select value={requirement} onChange={e => setRequirement(e.target.value)}>{REQUIREMENTS.map(r => <option key={r}>{r}</option>)}</select></Field>
      </form>
    </Modal>
  );
}

export function FieldLibraryPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Field Library' }]);
  const { hasRole } = useAuth();
  const ref = useReference();
  const canEdit = hasRole('config_admin');
  const [fields, setFields] = useState<EffectiveField[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [module, setModule] = useState('');
  const [requirement, setRequirement] = useState('');
  const [origin, setOrigin] = useState('');
  const [scope, setScope] = useState('');
  const [qRaw, setQ] = useState('');
  const q = useDebounced(qRaw.trim().toLowerCase(), 200);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<EffectiveField | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async (force = false) => {
    try { setFields(await ref.loadFields(force)); setError(null); } catch (e) { setError(e); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(0); }, [module, requirement, origin, scope, q]);

  const all = useMemo(() => fields ?? [], [fields]);
  const modules = useMemo(() => uniq(all.map(f => f.module)), [all]);
  const origins = useMemo(() => uniq(all.map(f => f.origin)), [all]);
  const groups = useMemo(() => uniq(all.map(f => f.group)), [all]);
  const filtered = useMemo(() => all.filter(f =>
    (!module || f.module === module) && (!requirement || f.requirement === requirement) && (!origin || f.origin === origin) &&
    (!scope || f.scope === scope) &&
    (!q || [f.label, f.coreLabel, f.fieldKey, f.libraryId, f.group].some(v => v.toLowerCase().includes(q)))), [all, module, requirement, origin, scope, q]);

  const tiles = useMemo(() => [{ key: '', label: 'All fields', count: all.length, tone: 'brand' as const },
    ...modules.map(m => ({ key: m, label: m, count: all.filter(f => f.module === m).length, tone: 'accent' as const }))], [all, modules]);

  const columns: Column<EffectiveField>[] = [
    { key: 'id', header: 'ID', cell: f => <span className="nowrap mono small">{f.libraryId}</span> },
    { key: 'label', header: 'Label', cell: f => <>
      <div className="strong">{f.overrideVersion !== null && <span className="ov-dot" title="Workspace override" aria-label="Has workspace override" />}{f.label}{f.hidden && <span className="core-tag">hidden</span>}</div>
      <div className="muted small mono break">{f.fieldKey}</div></> },
    { key: 'group', header: 'Group / module', hideSm: true, className: 'col-group', cell: f => <><div>{f.group}</div><div className="muted small">{f.module}</div></> },
    { key: 'type', header: 'Data type', hideSm: true, cell: f => f.dataType },
    { key: 'req', header: 'Requirement', cell: f => <RequirementBadge value={f.requirement} /> },
    { key: 'src', header: 'Source / adapter', hideSm: true, cell: f => <><div>{f.source}</div>{f.adapter && <div className="muted small">{f.adapter}</div>}</> },
    { key: 'origin', header: 'Origin', hideSm: true, cell: f => <OriginChip origin={f.origin} /> },
  ];

  return (
    <div className="page">
      <PageHead title="Field Library" subtitle="Creditum Core Field Library and workspace fields, with this workspace’s overrides applied."
        actions={canEdit ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>+ Custom field</button> : undefined} />
      {error ? <ErrorAlert error={error} onReload={() => load(true)} /> : !fields ? <Spinner /> : (
        <>
          <StatTiles label="Fields by module" tiles={tiles} active={module} onSelect={setModule} />
          <section className="card" aria-label="Field registry">
            <div className="filter-grid">
              <Field label="Module"><select value={module} onChange={e => setModule(e.target.value)}><option value="">All modules</option>{modules.map(m => <option key={m}>{m}</option>)}</select></Field>
              <Field label="Requirement"><select value={requirement} onChange={e => setRequirement(e.target.value)}><option value="">Any</option>{REQUIREMENTS.map(r => <option key={r}>{r}</option>)}</select></Field>
              <Field label="Origin"><select value={origin} onChange={e => setOrigin(e.target.value)}><option value="">Any</option>{origins.map(o => <option key={o}>{o}</option>)}</select></Field>
              <Field label="Scope"><select value={scope} onChange={e => setScope(e.target.value)}><option value="">Core and workspace</option><option value="core">Core</option><option value="tenant">Workspace</option></select></Field>
              <div className="field"><span className="field-label">Matches</span><div className="ro-value mono-num" style={{ minHeight: 36, padding: '6px 10px' }} aria-live="polite">{filtered.length}</div></div>
              <Field label="Search"><input type="search" value={qRaw} onChange={e => setQ(e.target.value)} placeholder="Label, key, ID or group…" /></Field>
            </div>
            <DataTable compact rows={filtered.slice(page * PAGE, (page + 1) * PAGE)} columns={columns} rowKey={f => f.fieldKey} caption="Fields"
              onRowClick={setSelected} rowLabel={f => `Open ${f.libraryId} ${f.label}`} empty="No fields match the filters." />
            <Pager page={page} pageSize={PAGE} total={filtered.length} onPage={setPage} />
          </section>
        </>
      )}
      {selected && <FieldDetail f={selected} canEdit={canEdit} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); void load(true); }} />}
      {creating && <CustomFieldModal modules={modules} groups={groups} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(true); }} />}
    </div>
  );
}
