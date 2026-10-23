/**
 * The seven Credit Request modules as tabs, rendered entirely from GET /api/layout.
 * Holds the editing state for the whole request (one save covers every tab), tracks dirty tabs,
 * and saves with optimistic locking (expectedVersion = the request's rowVersion).
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
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

export function CreditRequestModules({ requestId, header, headerVersion, canEdit, onVersion, onDirtyChange, handle }: {
  requestId: string;
  header: Header;
  /** The request's current rowVersion as the page knows it (header edits and transitions change it). */
  headerVersion: number;
  /** The user's role may edit the request data (the server still decides with `editable`). */
  canEdit: boolean;
  onVersion: (rowVersion: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  handle?: Ref<ModulesHandle>;
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
  const [saving, setSaving] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const apply = useCallback((d: RequestData) => {
    const s = fromData(d);
    setData(d); setOrig(s); setCur(s); setServerKeys(new Set());
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
  const selectTab = (code: string, focus = false) => {
    const p = new URLSearchParams(params); p.set('module', code); setParams(p, { replace: true });
    if (focus) tabRefs.current[code]?.focus();
  };

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
    setSaving(true); setSaveError(null);
    try {
      const res = await api.saveRequestData(requestId, payload(data.rowVersion, cur, ch, idx));
      apply(res);
      onVersion(res.rowVersion);
      toast.show('Changes saved — calculated values refreshed', 'ok');
      for (const w of res.warnings ?? []) toast.show(w, 'info');
    } catch (e) {
      setSaveError(e);
      if (e instanceof ApiError && e.status === 422) {
        const d = e.details as { key?: string; field?: string; keys?: string[]; fields?: string[] } | undefined;
        const keys = [d?.key, d?.field, ...(d?.keys ?? []), ...(d?.fields ?? []), ...e.missingFields.map(m => m.field)].filter((k): k is string => !!k);
        setServerKeys(new Set(keys));
      }
    } finally { setSaving(false); }
  };
  const discard = () => { if (orig) { setCur(orig); setSaveError(null); setServerKeys(new Set()); } };

  if (loadError && !data) return <ErrorAlert error={loadError} onReload={load} />;
  if (!layout || !data || !cur || !idx) return <Spinner label="Loading request modules…" />;

  const ctx: FormCtx = { layout, record: cur.record, grids: cur.grids, setRecord, setGrid, header, disabled: !editable || saving, missing };
  const activeModule = modules.find(m => m.code === active);
  const totals = Object.values(data.completeness.modules).reduce((a, m) => ({ f: a.f + m.filled, n: a.n + m.mandatory }), { f: 0, n: 0 });
  const moduleMissing = data.completeness.missing.filter(m => m.module === active);

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = modules.length;
    const go = (j: number) => { e.preventDefault(); selectTab(modules[(j + n) % n].code, true); };
    const rtl = document.documentElement.dir === 'rtl';
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) go(i + 1);
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
  };

  return (
    <section className="card modules-card" aria-label="Credit request details by module">
      <div className="modules-head">
        <div>
          <h2 className="modules-title">Credit request details</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Mandatory fields filled: <strong className="mono-num">{totals.f} / {totals.n}</strong>
            {data.completeness.mode !== 'off' && <> · at submission missing fields {data.completeness.mode === 'block' ? 'block the step' : 'are reported as warnings'}</>}
          </p>
        </div>
        {!editable && <span className="badge badge-neutral">{data.editable ? 'View only for your role' : 'Read-only at this stage'}</span>}
      </div>
      <div className="tabs module-tabs" role="tablist" aria-label="Modules">
        {modules.map((m, i) => {
          const c = data.completeness.modules[m.code];
          const complete = c && c.filled >= c.mandatory;
          const selected = m.code === active;
          return (
            <button key={m.code} type="button" role="tab" id={`mtab-${m.code}`} aria-selected={selected} aria-controls={`mpanel-${m.code}`}
              tabIndex={selected ? 0 : -1} className={selected ? 'active' : ''} ref={el => { tabRefs.current[m.code] = el; }}
              onClick={() => selectTab(m.code)} onKeyDown={e => onTabKey(e, i)}>
              <span className="tab-letter" aria-hidden="true">{m.letter.toUpperCase()}</span>
              {m.title}
              {c && <span className={`completeness ${complete ? 'done' : ''}`} aria-label={`${c.filled} of ${c.mandatory} mandatory fields filled`}>{c.filled}/{c.mandatory}</span>}
              {dirtyTabs.has(m.code) && <span className="dirty-dot" aria-label="unsaved changes" title="Unsaved changes" />}
            </button>
          );
        })}
      </div>
      {activeModule && (
        <div role="tabpanel" id={`mpanel-${activeModule.code}`} aria-labelledby={`mtab-${activeModule.code}`} className="module-panel" tabIndex={-1}>
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
            <details className="missing-list">
              <summary><span className="badge badge-warn">{moduleMissing.length}</span> mandatory field{moduleMissing.length === 1 ? '' : 's'} still empty in {activeModule.title}</summary>
              <ul>{moduleMissing.slice(0, 40).map(m => (
                <li key={`${m.key}@${m.rowKey ?? ''}`}><button type="button" className="link-btn small" onClick={() => focusField(m)}>{m.label}</button></li>
              ))}</ul>
            </details>
          )}
          <div className="section-groups">
            {activeModule.sections.map(s => <SectionRenderer key={s.code} section={s} ctx={ctx} />)}
          </div>
        </div>
      )}
      {editable && (dirty || saving) && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span className="grow">
            <strong>Unsaved changes</strong>
            <span className="muted small"> in {modules.filter(m => dirtyTabs.has(m.code)).map(m => m.title).join(', ') || '…'}</span>
            {invalid.size > 0 && <span className="err-text small"> · fix {invalid.size} invalid number{invalid.size === 1 ? '' : 's'} before saving</span>}
          </span>
          <button type="button" className="btn btn-secondary" onClick={discard} disabled={saving}>Discard</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || invalid.size > 0}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </section>
  );
}
