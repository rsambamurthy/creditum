/**
 * The seven Credit Request modules as tabs, rendered entirely from GET /api/layout.
 * Holds the editing state for the whole request (one save covers every tab), tracks dirty tabs,
 * and saves with optimistic locking (expectedVersion = the request's rowVersion).
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type ReactNode, type Ref } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage, type FormValue, type Layout, type MissingEntry, type RequestData } from '../api';
import { useReference } from '../reference';
import { Alert, ErrorAlert, Spinner } from '../components/Feedback';
import { useToast } from '../components/Toast';
import { changes, dirtyModules, fromData, indexLayout, invalidDecimals, payload, type FormState, type LocalRow } from './formState';
import { fieldDomId, sectionDomId, SectionRenderer, type FormCtx } from './SectionRenderer';
import type { Header } from './FieldInput';

export interface ModulesHandle {
  /** Switch to the field's tab and scroll it into view. */
  focusField: (m: MissingEntry) => void;
  /** Reload the data (after a transition or a header change). */
  reload: () => Promise<void>;
}

export function CreditRequestModules({ requestId, header, headerVersion, canEdit, onVersion, onDirtyChange, handle, navFooter }: {
  requestId: string;
  header: Header;
  /** The request's current rowVersion as the page knows it (header edits and transitions change it). */
  headerVersion: number;
  /** The user's role may edit the request data (the server still decides with `editable`). */
  canEdit: boolean;
  onVersion: (rowVersion: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  handle?: Ref<ModulesHandle>;
  /** Extra entries at the bottom of the module navigation (history, audit). */
  navFooter?: ReactNode;
}) {
  const ref = useReference();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [data, setData] = useState<RequestData | null>(null);
  const [orig, setOrig] = useState<FormState | null>(null);
  const [cur, setCur] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [serverKeys, setServerKeys] = useState<Set<string>>(new Set());
  /** Messages the server attached to one field (422 invalid_value): "key" or "key@rowKey" → message. */
  const [serverMessages, setServerMessages] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [currentSection, setCurrentSection] = useState<string | null>(null);

  const apply = useCallback((d: RequestData) => {
    const s = fromData(d);
    setData(d); setOrig(s); setCur(s); setServerKeys(new Set()); setServerMessages(new Map());
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [l, d] = await Promise.all([ref.loadLayout(), api.requestData(requestId)]);
      setLayout(l); apply(d); setSaveError(null);
      onVersion(d.rowVersion);
    } catch (e) { setLoadError(e); }
  }, [ref, requestId, apply, onVersion]);
  useEffect(() => { void load(); }, [requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const idx = useMemo(() => (layout ? indexLayout(layout) : null), [layout]);
  const ch = useMemo(() => (orig && cur && idx ? changes(orig, cur, idx) : { record: [], grids: [] }), [orig, cur, idx]);
  const dirty = ch.record.length > 0 || ch.grids.length > 0;
  const dirtyTabs = useMemo(() => (idx ? dirtyModules(ch, idx) : new Set<string>()), [ch, idx]);
  const invalid = useMemo(() => (cur && idx ? invalidDecimals(cur, idx) : new Set<string>()), [cur, idx]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // The header form or a transition moved the version on: refresh, unless the user has unsaved edits.
  useEffect(() => {
    if (data && headerVersion !== data.rowVersion && !dirty) void load();
  }, [headerVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const modules = layout?.modules ?? [];
  const active = modules.find(m => m.code === params.get('module'))?.code ?? modules[0]?.code;
  const selectTab = (code: string) => {
    const p = new URLSearchParams(params); p.set('module', code); setParams(p, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  // Module navigation: any module's section list can be opened or closed, the active one included.
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const open = expanded ?? new Set(active ? [active] : []);
  const toggleModule = (code: string) => setExpanded(() => {
    const n = new Set(open); if (n.has(code)) n.delete(code); else n.add(code); return n;
  });
  const setAll = (on: boolean) => setExpanded(new Set(on ? modules.map(m => m.code) : []));
  const openModule = (code: string) => {
    if (code === active) { toggleModule(code); return; }
    setExpanded(new Set([...open, code]));
    selectTab(code);
  };
  const goSection = (module: string, code: string) => {
    if (module !== active) selectTab(module);
    setCurrentSection(code);
    // A section of another module exists only after the module renders: wait for it.
    const started = Date.now();
    const attempt = () => {
      const el = document.getElementById(sectionDomId(code));
      if (!el && Date.now() - started < 1500) { window.requestAnimationFrame(attempt); return; }
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    window.requestAnimationFrame(attempt);
  };
  // Scroll-spy: highlight the section in view in the module navigation.
  useEffect(() => {
    const mod = layout?.modules.find(m => m.code === active);
    if (!mod || typeof IntersectionObserver === 'undefined') return;
    const els = mod.sections.map(sc => document.getElementById(sectionDomId(sc.code))).filter((e): e is HTMLElement => !!e);
    const seen = new Map<string, boolean>();
    const obs = new IntersectionObserver(entries => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = mod.sections.find(sc => seen.get(sectionDomId(sc.code)));
      if (first) setCurrentSection(first.code);
    }, { rootMargin: '-180px 0px -55% 0px' });
    els.forEach(e => obs.observe(e));
    return () => obs.disconnect();
  }, [layout, active, data]);

  const focusField = (m: MissingEntry) => {
    selectTab(m.module);
    // The tab switch renders asynchronously (router transition): wait for the field to exist, then scroll and focus it.
    const started = Date.now();
    const attempt = () => {
      const el = document.getElementById(fieldDomId(m.key, m.rowKey))
        ?? (m.rowKey ? document.getElementById(`row-${fieldDomId(m.section, m.rowKey)}`) : null);
      if (!el && Date.now() - started < 1500) { window.requestAnimationFrame(attempt); return; }
      const target = el ?? document.getElementById(sectionDomId(m.section));
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (target?.querySelector<HTMLElement>('textarea, input, select') ?? target?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    };
    window.requestAnimationFrame(attempt);
  };
  useImperativeHandle(handle, () => ({ focusField, reload: load }));

  const missing = useMemo(() => {
    const s = new Set<string>(serverKeys);
    for (const m of data?.completeness.missing ?? []) s.add(m.rowKey ? `${m.key}@${m.rowKey}` : m.key);
    return s;
  }, [data, serverKeys]);

  const editable = !!data?.editable && canEdit;
  const setRecord = useCallback((key: string, v: FormValue) => setCur(c => (c ? { ...c, record: { ...c.record, [key]: v } } : c)), []);
  const setGrid = useCallback((grid: string, rows: LocalRow[]) => setCur(c => (c ? { ...c, grids: { ...c.grids, [grid]: rows } } : c)), []);

  const save = async () => {
    if (!data || !cur || !idx || !dirty || invalid.size) return;
    setSaving(true); setSaveError(null); setServerMessages(new Map());
    try {
      const res = await api.saveRequestData(requestId, payload(data.rowVersion, cur, ch, idx));
      apply(res);
      onVersion(res.rowVersion);
      toast.show('Changes saved — calculated values refreshed', 'ok');
      for (const w of res.warnings ?? []) toast.show(w, 'info');
    } catch (e) {
      setSaveError(e);
      if (e instanceof ApiError && e.status === 422) {
        const d = e.details as { key?: string; field?: string; rowKey?: string | null; keys?: string[]; fields?: string[] } | undefined;
        const named = d?.field ? (d.rowKey ? `${d.field}@${d.rowKey}` : d.field) : null;
        if (e.code === 'invalid_value' && named) setServerMessages(new Map([[named, e.message.replace(/^[^:]+:\s*/, '')]]));
        const keys = [d?.key, e.code === 'invalid_value' ? null : named, ...(d?.keys ?? []), ...(d?.fields ?? []), ...e.missingFields.map(m => m.field)]
          .filter((k): k is string => !!k);
        setServerKeys(new Set(keys));
        // Take the user to the field the server named (e.g. 422 invalid_value with details.field).
        const pl = d?.field ? idx.fields.get(d.field) : undefined;
        if (pl) focusField({ key: d!.field!, label: pl.meta.label, module: pl.module, section: pl.section, rowKey: d?.rowKey ?? null });
      }
    } finally { setSaving(false); }
  };
  const discard = () => { if (orig) { setCur(orig); setSaveError(null); setServerKeys(new Set()); } };

  if (loadError && !data) return <ErrorAlert error={loadError} onReload={load} />;
  if (!layout || !data || !cur || !idx) return <Spinner label="Loading request modules…" />;

  const ctx: FormCtx = { layout, record: cur.record, grids: cur.grids, setRecord, setGrid, header, disabled: !editable || saving, missing, messages: serverMessages };
  const activeModule = modules.find(m => m.code === active);
  const totals = Object.values(data.completeness.modules).reduce((a, m) => ({ f: a.f + m.filled, n: a.n + m.mandatory }), { f: 0, n: 0 });
  const moduleMissing = data.completeness.missing.filter(m => m.module === active);

  const c0 = activeModule ? data.completeness.modules[activeModule.code] : undefined;
  const pct = (c?: { filled: number; mandatory: number }) => (c && c.mandatory ? Math.round((100 * c.filled) / c.mandatory) : 100);

  return (
    <div className="req-workspace">
      <div className="req-main">
        {activeModule && (
          <section id={`mpanel-${activeModule.code}`} className="module-panel" aria-labelledby={`mhead-${activeModule.code}`}>
            <div className="module-head">
              <h2 id={`mhead-${activeModule.code}`}><span className="tab-letter" aria-hidden="true">{activeModule.letter.toUpperCase()}</span>{activeModule.title}</h2>
              {c0 && c0.mandatory > 0 && (
                <span className="mh-progress" aria-label={`${c0.filled} of ${c0.mandatory} mandatory fields filled`}>
                  <span className="mh-bar"><span style={{ width: `${pct(c0)}%` }} /></span>
                  <span className="mono-num">{c0.filled}/{c0.mandatory} mandatory</span>
                </span>
              )}
              {!editable && <span className="badge badge-neutral">{data.editable ? 'View only for your role' : 'Read-only at this stage'}</span>}
            </div>
            {saveError instanceof ApiError && saveError.isConflict ? (
              <Alert tone="warning" action={<button type="button" className="btn btn-secondary btn-sm" onClick={load}>Reload</button>}>
                This request was changed by someone else — reload to see the latest version. Your unsaved changes will be discarded.
              </Alert>
            ) : saveError ? (
              <Alert tone="error">
                {errorMessage(saveError)}
                {saveError instanceof ApiError && saveError.missingFields.length > 0 && idx && (
                  <ul>{saveError.missingFields.map(m => {
                    const pl = idx.fields.get(m.field);
                    return (
                      <li key={m.field}>
                        <strong>{pl?.meta.label ?? m.field}</strong>{pl && <> — <button type="button" className="link-btn small"
                          onClick={() => focusField({ key: m.field, label: pl.meta.label, module: pl.module, section: pl.section, rowKey: null })}>go to the field</button></>}
                      </li>
                    );
                  })}</ul>
                )}
              </Alert>
            ) : null}
            {moduleMissing.length > 0 && editable && (
              <details className="missing-line">
                <summary><span className="badge badge-warn sm">{moduleMissing.length}</span> mandatory field{moduleMissing.length === 1 ? '' : 's'} still empty in this module <span className="link-btn small">Show</span></summary>
                <ul>{moduleMissing.slice(0, 60).map(m => (
                  <li key={`${m.key}@${m.rowKey ?? ''}`}><button type="button" className="link-btn small" onClick={() => focusField(m)}>{m.label}</button></li>
                ))}</ul>
              </details>
            )}
            <div className="section-groups">
              {activeModule.sections.map(sc => <SectionRenderer key={sc.code} section={sc} ctx={ctx} />)}
            </div>
          </section>
        )}
        {editable && (dirty || saving) && (
          <div className="save-bar" role="region" aria-label="Unsaved changes">
            <span className="grow">
              <strong>Unsaved changes</strong>
              <span className="muted small"> in {modules.filter(m => dirtyTabs.has(m.code)).map(m => m.title).join(', ') || '…'}</span>
              {invalid.size > 0 && <span className="err-text small"> · fix {invalid.size} value{invalid.size === 1 ? '' : 's'} marked in red before saving</span>}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={discard} disabled={saving}>Discard</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving || invalid.size > 0}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        )}
      </div>

      <nav className="req-nav" aria-label="Credit request modules">
        <div className="rn-head">
          <span>Modules</span>
          <button type="button" className="rn-all" onClick={() => setAll(open.size === 0)}>{open.size === 0 ? 'Expand all' : 'Collapse all'}</button>
          <span className="rn-total mono-num" title={data.completeness.mode !== 'off' ? `At submission missing fields ${data.completeness.mode === 'block' ? 'block the step' : 'are reported as warnings'}` : undefined}>
            {totals.f}/{totals.n} mandatory
          </span>
        </div>
        <ul className="rn-list">
          {modules.map(m => {
            const c = data.completeness.modules[m.code];
            const selected = m.code === active;
            const state = !c || c.mandatory === 0 ? 'none' : c.filled >= c.mandatory ? 'done' : c.filled > 0 ? 'part' : 'empty';
            return (
              <li key={m.code}>
                <button type="button" className={`rn-item ${selected ? 'active' : ''}`} aria-current={selected ? 'page' : undefined}
                  aria-expanded={open.has(m.code)} aria-controls={`rn-sec-${m.code}`} onClick={() => openModule(m.code)}>
                  <span className="tab-letter" aria-hidden="true">{m.letter.toUpperCase()}</span>
                  <span className="rn-title" title={m.title}>{m.title}</span>
                  {dirtyTabs.has(m.code) && <span className="dirty-dot" aria-label="unsaved changes" title="Unsaved changes" />}
                  {c && c.mandatory > 0 && <span className={`rn-count ${state}`} aria-label={`${c.filled} of ${c.mandatory} mandatory fields filled`}>{c.filled}/{c.mandatory}</span>}
                  <span className={`rn-chev ${open.has(m.code) ? 'open' : ''}`} aria-hidden="true" />
                </button>
                {open.has(m.code) && (
                  <ul className="rn-sections" id={`rn-sec-${m.code}`}>
                    {m.sections.map(sc => (
                      <li key={sc.code}>
                        <button type="button" className={selected && currentSection === sc.code ? 'current' : ''} aria-current={selected && currentSection === sc.code ? 'location' : undefined}
                          onClick={() => goSection(m.code, sc.code)}>{sc.title}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {navFooter && <div className="rn-foot">{navFooter}</div>}
      </nav>
    </div>
  );
}
