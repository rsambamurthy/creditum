import { useEffect, useState, type KeyboardEvent } from 'react';
import { api, ApiError, errorMessage, type LayoutAdmin, type LayoutDocField, type LayoutDocument, type LayoutDocSection, type WriteResult } from '../api';
import { useAuth } from '../auth';
import { useReference } from '../reference';
import { formatDateTime } from '../format';
import { useCrumbs } from '../layout/crumbs';
import { Alert, ChangeStatus, ErrorAlert, PageHead, Spinner } from '../components/Feedback';
import { Badge } from '../components/Badge';
import { useToast } from '../components/Toast';

const TENANT_SECTION = /\.t\./;

function swap<T>(xs: T[], i: number, d: number): boolean {
  const j = i + d;
  if (j < 0 || j >= xs.length) return false;
  [xs[i], xs[j]] = [xs[j], xs[i]];
  return true;
}

function slug(s: string) { return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); }

/**
 * Edits the arrangement of the Credit Request screens. The document is changed in place on a deep copy, so every
 * property the API sent (kind, grid, rowLabel, field properties) goes back untouched.
 */
export function ScreenLayoutPage() {
  useCrumbs([{ label: 'Administration' }, { label: 'Screen Layout' }]);
  const { hasRole } = useAuth();
  const ref = useReference();
  const toast = useToast();
  const canEdit = hasRole('config_admin');
  const [view, setView] = useState<LayoutAdmin | null>(null);
  const [doc, setDoc] = useState<LayoutDocument | null>(null);
  const [orig, setOrig] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState('');

  const load = async () => {
    setLoadError(null);
    try {
      const v = await api.layoutAdmin();
      setView(v); setDoc(structuredClone(v.document)); setOrig(JSON.stringify(v.document)); setError(null);
    } catch (e) { setLoadError(e); }
  };
  useEffect(() => { void load(); }, []);

  if (loadError) return <div className="page"><ErrorAlert error={loadError} onReload={load} /></div>;
  if (!view || !doc) return <div className="page"><Spinner /></div>;

  const dirty = JSON.stringify(doc) !== orig;
  const edit = (fn: (d: LayoutDocument) => void) => { const d = structuredClone(doc); fn(d); setDoc(d); setResult(null); };
  const mod = doc.modules[Math.min(active, doc.modules.length - 1)];
  const recordSections = doc.modules.flatMap(m => m.sections.filter(s => s.kind === 'record').map(s => ({ module: m, section: s })));
  const toggle = (code: string) => setOpen(o => { const n = new Set(o); if (n.has(code)) n.delete(code); else n.add(code); return n; });

  const save = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.saveLayout(doc);
      setResult(r); toast.configResult(r, 'Screen layout saved');
      if (r.status === 'applied') { ref.reload(); await load(); setResult(r); } else setOrig(JSON.stringify(doc));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!window.confirm('Reset every module, section and field arrangement to the core layout? Your workspace sections and titles will be removed.')) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.resetLayout();
      setResult(r); toast.configResult(r, 'Core layout restored');
      if (r.status === 'applied') { ref.reload(); await load(); setResult(r); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const addSection = () => {
    const name = slug(newTitle);
    if (!name) return;
    const code = `${mod.letter}.t.${name}`;
    if (doc.modules.some(m => m.sections.some(s => s.code === code))) { setError(new Error(`A section with code ${code} already exists`)); return; }
    edit(d => { d.modules[active].sections.push({ code, title: newTitle.trim(), kind: 'record', fields: [] }); });
    setOpen(o => new Set(o).add(code)); setNewTitle('');
  };
  const moveField = (fromSection: string, key: string, toSection: string) => edit(d => {
    const from = d.modules.flatMap(m => m.sections).find(s => s.code === fromSection)!;
    const to = d.modules.flatMap(m => m.sections).find(s => s.code === toSection)!;
    const i = from.fields.findIndex(f => f.key === key);
    const [f] = from.fields.splice(i, 1);
    to.fields.push(f);
  });

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = doc.modules.length;
    if (e.key === 'ArrowRight') { e.preventDefault(); setActive((i + 1) % n); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setActive((i - 1 + n) % n); }
  };

  const fieldRows = ({ section, list, mi, si, record }: { section: LayoutDocSection; list: LayoutDocField[]; mi: number; si: number; record: boolean }) => (
    <ul className="layout-fields">
      {list.map((f, fi) => {
        const meta = view.fields[f.key];
        return (
          <li key={f.key}>
            <span className="lf-main">
              <span className="lf-label">{meta?.label ?? f.key}</span>
              <span className="muted small">{meta?.dataType ?? ''}{meta?.requirement === 'Mandatory' ? ' · Mandatory' : ''}</span>
            </span>
            <span className="lf-chips">
              {meta?.hidden && <Badge tone="neutral">Hidden</Badge>}
              {meta?.calculated && <Badge tone="auto">Calculated</Badge>}
              {meta?.scope === 'tenant' && <Badge tone="info">Custom</Badge>}
            </span>
            {canEdit && (
              <span className="row-tools">
                {record && (
                  <select className="input-sm" aria-label={`Move ${meta?.label ?? f.key} to another section`} value=""
                    onChange={e => { if (e.target.value) moveField(section.code, f.key, e.target.value); }}>
                    <option value="">Move to section…</option>
                    {doc.modules.map(m => (
                      <optgroup key={m.code} label={m.title}>
                        {recordSections.filter(r => r.module.code === m.code && r.section.code !== section.code).map(r => <option key={r.section.code} value={r.section.code}>{r.section.title}</option>)}
                      </optgroup>
                    ))}
                  </select>
                )}
                <button type="button" className="icon-btn" disabled={fi === 0} aria-label={`Move ${meta?.label ?? f.key} up`}
                  onClick={() => edit(d => { const s = d.modules[mi].sections[si]; swap(record ? s.fields : s.columns!, fi, -1); })}>↑</button>
                <button type="button" className="icon-btn" disabled={fi === list.length - 1} aria-label={`Move ${meta?.label ?? f.key} down`}
                  onClick={() => edit(d => { const s = d.modules[mi].sections[si]; swap(record ? s.fields : s.columns!, fi, 1); })}>↓</button>
              </span>
            )}
          </li>
        );
      })}
      {list.length === 0 && <li className="muted small">No fields — move record-level fields here with “Move to section…”.</li>}
    </ul>
  );

  return (
    <div className="page">
      <PageHead title="Screen Layout" subtitle="Arrange the Credit Request modules, sections and fields for this workspace. Where data is stored never changes."
        actions={canEdit ? <>
          <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy || view.scope === 'core'}>Reset to core layout</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save layout'}</button>
        </> : undefined} />
      <div className="summary-strip" role="group" aria-label="Layout status">
        <span>Using: <strong>{view.scope === 'core' ? 'Core layout' : 'Tenant layout'}</strong></span>
        <span>Core version: <strong>{view.coreVersion}</strong></span>
        <span>Last changed: <strong>{formatDateTime(view.updatedAt)}</strong></span>
        {dirty && <span className="warn-text">Unsaved changes</span>}
      </div>
      <ChangeStatus result={result} what="The new layout" />
      {error instanceof ApiError && error.status === 422 ? <Alert tone="error">{errorMessage(error)}</Alert> : <ErrorAlert error={error} onReload={load} />}

      <section className="card">
        <div className="tabs" role="tablist" aria-label="Modules">
          {doc.modules.map((m, i) => (
            <button key={m.code} type="button" role="tab" aria-selected={i === active} tabIndex={i === active ? 0 : -1} className={i === active ? 'active' : ''}
              onClick={() => setActive(i)} onKeyDown={e => onTabKey(e, i)}>
              <span className="tab-letter" aria-hidden="true">{m.letter.toUpperCase()}</span>{m.title}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="card-body">
          <div className="layout-module-bar">
            {canEdit ? (
              <label className="inline-title">
                <span className="field-label">Module title</span>
                <input value={mod.title} onChange={e => { const v = e.target.value; edit(d => { d.modules[active].title = v; }); }} maxLength={120} />
              </label>
            ) : <h3>{mod.title}</h3>}
            {canEdit && (
              <span className="row-tools">
                <button type="button" className="btn btn-secondary btn-sm" disabled={active === 0} onClick={() => { edit(d => { swap(d.modules, active, -1); }); setActive(active - 1); }}>Move module earlier</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={active === doc.modules.length - 1} onClick={() => { edit(d => { swap(d.modules, active, 1); }); setActive(active + 1); }}>Move module later</button>
              </span>
            )}
            <span className="grow" />
            <button type="button" className="link-btn small" onClick={() => setOpen(new Set(mod.sections.map(s => s.code)))}>Expand all</button>
            <button type="button" className="link-btn small" onClick={() => setOpen(new Set())}>Collapse all</button>
          </div>

          <ol className="layout-sections">
            {mod.sections.map((s, si) => {
              const isOpen = open.has(s.code);
              const count = s.fields.length + (s.columns?.length ?? 0);
              const deletable = TENANT_SECTION.test(s.code) && count === 0;
              return (
                <li key={s.code} className="layout-section card">
                  <div className="ls-head">
                    <button type="button" className="ls-toggle" aria-expanded={isOpen} aria-controls={`ls-${s.code}`} onClick={() => toggle(s.code)}>
                      <span className={`chev${isOpen ? ' open' : ''}`} aria-hidden="true">▸</span>
                      <span className="sr-only">{isOpen ? 'Collapse' : 'Expand'} {s.title}</span>
                    </button>
                    {canEdit
                      ? <input className="ls-title" aria-label={`Title of section ${s.code}`} value={s.title} onChange={e => { const v = e.target.value; edit(d => { d.modules[active].sections[si].title = v; }); }} maxLength={160} />
                      : <span className="ls-title-ro">{s.title}</span>}
                    <span className="lf-chips">
                      <Badge tone="neutral">{s.kind === 'record' ? 'Record' : s.kind === 'grid' ? 'Grid' : 'Periods'}</Badge>
                      {TENANT_SECTION.test(s.code) && <Badge tone="info">Tenant section</Badge>}
                      <span className="muted small">{count} field{count === 1 ? '' : 's'}</span>
                    </span>
                    {canEdit && (
                      <span className="row-tools">
                        <button type="button" className="icon-btn" disabled={si === 0} aria-label={`Move section ${s.title} up`} onClick={() => edit(d => { swap(d.modules[active].sections, si, -1); })}>↑</button>
                        <button type="button" className="icon-btn" disabled={si === mod.sections.length - 1} aria-label={`Move section ${s.title} down`} onClick={() => edit(d => { swap(d.modules[active].sections, si, 1); })}>↓</button>
                        {deletable && <button type="button" className="icon-btn danger" aria-label={`Delete empty section ${s.title}`} onClick={() => edit(d => { d.modules[active].sections.splice(si, 1); })}>✕</button>}
                      </span>
                    )}
                  </div>
                  {isOpen && (
                    <div id={`ls-${s.code}`} className="ls-body">
                      <p className="muted small mono" style={{ margin: '0 0 8px' }}>{s.code}{s.grid ? ` · grid ${s.grid}` : ''}</p>
                      {(s.fields.length > 0 || s.kind === 'record') && <>
                        {s.kind !== 'record' && <p className="sub-head">Fields above the table</p>}
                        {fieldRows({ section: s, list: s.fields, mi: active, si: si, record: true })}
                      </>}
                      {s.kind !== 'record' && <>
                        <p className="sub-head">{s.kind === 'periods' ? 'Line items (order only)' : 'Columns (order only)'}</p>
                        {fieldRows({ section: s, list: s.columns ?? [], mi: active, si: si, record: false })}
                      </>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {canEdit && (
            <div className="add-section">
              <label htmlFor="new-sec" className="field-label">New record section in {mod.title}</label>
              <div className="inline-form">
                <input id="new-sec" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Section title, e.g. KYC" maxLength={160}
                  onKeyDown={e => { if (e.key === 'Enter') addSection(); }} />
                <button type="button" className="btn btn-secondary" onClick={addSection} disabled={!slug(newTitle)}>+ Add section</button>
              </div>
              {slug(newTitle) && <span className="field-help">Code: <span className="mono">{mod.letter}.t.{slug(newTitle)}</span></span>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
