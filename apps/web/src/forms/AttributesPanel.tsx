/**
 * Field attributes of one field: the effective value of each attribute with where it comes from (Product → Market → Bank),
 * an editor for the bank's own layer, the format cases by another field's value, and a "test a value" box.
 * Saves ONLY the bank layer: attributes that differ from the inherited value; null removes an inherited one.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage, type EffectiveField, type FieldAttributeLayers, type Layout, type WriteResult } from '../api';
import { useReference } from '../reference';
import { Alert, ChangeStatus, ErrorAlert, Spinner } from '../components/Feedback';
import { useToast } from '../components/Toast';
import { checkValue, mergeAttributes, transformText, WIDTHS, type AttrKind, type FieldAttributes, type FormatRule } from './attributes';

const TEXT_TYPES = new Set(['Text', 'Rich Text', 'Text (identifier)', 'Address (structured)']);
const NUMBER_TYPES = new Set(['Currency Amount', 'Percentage', 'Ratio (decimal)', 'Decimal', 'Integer', 'Integer (days)']);
export const kindOfType = (dataType: string): AttrKind => (TEXT_TYPES.has(dataType) ? 'text' : NUMBER_TYPES.has(dataType) ? 'decimal' : 'other');

const MARKET_NAMES: Record<string, string> = { gcc: 'Gulf Cooperation Council', in: 'India' };
export const marketName = (code: string) => `${MARKET_NAMES[code] ?? code.toUpperCase()} (${code})`;

type AttrKey = 'maxLength' | 'minLength' | 'pattern' | 'patternHint' | 'transform' | 'placeholder' | 'maxDecimals' | 'minValue' | 'maxValue' | 'width' | 'rows';
const LABEL: Record<AttrKey, string> = {
  maxLength: 'Maximum length', minLength: 'Minimum length', pattern: 'Format (regular expression)', patternHint: 'Format example',
  transform: 'Letter case', placeholder: 'Placeholder', maxDecimals: 'Decimal places', minValue: 'Minimum value', maxValue: 'Maximum value',
  width: 'Width on screen', rows: 'Text area rows',
};
const NUMERIC: AttrKey[] = ['maxLength', 'minLength', 'maxDecimals', 'rows'];
const WIDTH_LABEL: Record<string, string> = { xs: 'Extra small', s: 'Small', m: 'Medium', l: 'Large', full: 'Full width' };

function attrsFor(kind: AttrKind, dataType: string): AttrKey[] {
  const multi = dataType === 'Rich Text' || dataType === 'Address (structured)';
  if (kind === 'text') return ['maxLength', 'minLength', 'pattern', 'patternHint', 'transform', 'placeholder', 'width', ...(multi ? ['rows' as const] : [])];
  if (kind === 'decimal') return ['maxDecimals', 'minValue', 'maxValue', 'placeholder', 'width'];
  return ['width'];
}

const asText = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const parse = (k: AttrKey, s: string): unknown => (s.trim() === '' ? undefined : NUMERIC.includes(k) ? Number(s.trim()) : s.trim());
const same = (a: unknown, b: unknown) => asText(a) === asText(b);
/** JSON with sorted keys, so two layers compare equal whatever order their attributes were written in. */
const canon = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`);

interface CaseDraft { code: string; pattern: string; patternHint: string; maxLength: string; transform: string; removed: boolean; isNew: boolean }

export function AttributesPanel({ field, canEdit }: { field: EffectiveField; canEdit: boolean }) {
  const ref = useReference();
  const toast = useToast();
  const [layers, setLayers] = useState<FieldAttributeLayers | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cases, setCases] = useState<CaseDraft[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [testValue, setTestValue] = useState('');
  const [testCase, setTestCase] = useState('');
  const kind = kindOfType(field.dataType);
  const keys = attrsFor(kind, field.dataType);

  const load = async () => {
    setLoadError(null);
    try {
      const [l, lay] = await Promise.all([api.fieldAttributes(field.fieldKey), ref.loadLayout().catch(() => null)]);
      setLayers(l); setLayout(lay);
      setDraft(Object.fromEntries(keys.map(k => [k, asText((l.effective as Record<string, unknown>)[k])])));
      setCases(Object.entries(l.effective.variants?.cases ?? {}).map(([code, r]) => ({ code, pattern: asText(r.pattern), patternHint: asText(r.patternHint),
        maxLength: asText(r.maxLength), transform: asText(r.transform), removed: false, isNew: false })));
    } catch (e) { setLoadError(e); }
  };
  useEffect(() => { void load(); }, [field.fieldKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const inherited = useMemo(() => (layers ? mergeAttributes(layers.core, layers.marketLayer) : {}), [layers]);
  const dependsOn = layers?.effective.variants?.dependsOn ?? inherited.variants?.dependsOn;
  const depMeta = useMemo(() => {
    if (!dependsOn || !layout) return undefined;
    for (const m of layout.modules) for (const s of m.sections) for (const f of [...s.fields, ...(s.columns ?? [])]) if (f.key === dependsOn) return f;
    return undefined;
  }, [dependsOn, layout]);
  const caseLabel = (code: string) => (depMeta?.list ? layout?.lists[depMeta.list]?.find(e => e.code === code)?.label : undefined) ?? code;
  const freeCodes = (depMeta?.list ? layout?.lists[depMeta.list] ?? [] : []).filter(e => !cases.some(c => c.code === e.code && !c.removed));

  /** The bank layer to send: only what differs from the inherited value; null where an inherited value was cleared. */
  const bankLayer = useMemo((): FieldAttributes => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const inh = (inherited as Record<string, unknown>)[k];
      const v = parse(k, draft[k] ?? '');
      if (v === undefined) { if (inh !== undefined) out[k] = null; }
      else if (!same(v, inh)) out[k] = v;
    }
    if (dependsOn) {
      const changed: Record<string, FormatRule> = {};
      for (const c of cases) {
        const inh = inherited.variants?.cases[c.code] ?? {};
        if (c.removed) { if (!c.isNew) changed[c.code] = { pattern: null, patternHint: null, maxLength: null, transform: null }; continue; }
        const now: Record<string, unknown> = { pattern: c.pattern.trim() || undefined, patternHint: c.patternHint.trim() || undefined,
          maxLength: c.maxLength.trim() ? Number(c.maxLength) : undefined, transform: c.transform || undefined };
        const diff: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(now)) {
          const i = (inh as Record<string, unknown>)[k];
          if (v === undefined) { if (i !== undefined && i !== null) diff[k] = null; } else if (!same(v, i)) diff[k] = v;
        }
        if (Object.keys(diff).length) changed[c.code] = diff as FormatRule;
      }
      if (Object.keys(changed).length) out.variants = { dependsOn, cases: changed };
    }
    return out as FieldAttributes;
  }, [draft, cases, inherited, keys, dependsOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useMemo(() => mergeAttributes(inherited, bankLayer), [inherited, bankLayer]);
  const dirty = canon(bankLayer) !== canon(layers?.tenant ?? {});

  if (loadError) return <ErrorAlert error={loadError} onReload={load} />;
  if (!layers) return <Spinner label="Loading field attributes…" />;

  const source = (k: string) => {
    if (layers.tenant && k in layers.tenant) return <span className="attr-chip bank">Bank</span>;
    if (layers.marketLayer && k in layers.marketLayer) return <span className="attr-chip market">Market</span>;
    if (layers.core && k in layers.core) return <span className="attr-chip product">Product</span>;
    return <span className="muted small">—</span>;
  };
  const effText = (k: AttrKey, v: unknown) => (v === undefined ? <span className="muted">not set</span>
    : k === 'width' ? WIDTH_LABEL[String(v)] ?? String(v) : k === 'transform' ? (v === 'upper' ? 'UPPER CASE' : 'lower case') : k === 'pattern' ? <span className="mono">{String(v)}</span> : String(v));

  const save = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.saveFieldAttributes(field.fieldKey, bankLayer, layers.tenantVersion);
      if (r.status === 'applied') { ref.reload(); await load(); }
      setResult(r); toast.configResult(r, `Attributes of ${field.label} saved`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!window.confirm(`Remove this bank's own attributes for “${field.label}” and use the ${marketName(layers.market)} market profile and product defaults again?`)) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.revertFieldAttributes(field.fieldKey);
      if (r.status === 'applied') { ref.reload(); await load(); }
      setResult(r); toast.configResult(r, 'Attributes reset to the market profile');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const testResult = testValue ? checkValue(testValue, preview, kind, testCase || undefined) : null;
  const testRule = preview.variants && testCase ? { ...preview, ...(preview.variants.cases[testCase] ?? {}) } : preview;

  const input = (k: AttrKey) => {
    const set = (v: string) => setDraft(d => ({ ...d, [k]: v }));
    const v = draft[k] ?? '';
    const id = `attr-${k}`;
    if (k === 'transform') return <select id={id} value={v} onChange={e => set(e.target.value)} disabled={!canEdit}><option value="">As typed</option><option value="upper">UPPER CASE</option><option value="lower">lower case</option></select>;
    if (k === 'width') return <select id={id} value={v} onChange={e => set(e.target.value)} disabled={!canEdit}><option value="">Default</option>{WIDTHS.map(w => <option key={w} value={w}>{WIDTH_LABEL[w]}</option>)}</select>;
    const numeric = NUMERIC.includes(k) || k === 'minValue' || k === 'maxValue';
    return <input id={id} value={v} onChange={e => set(e.target.value)} disabled={!canEdit} inputMode={numeric ? 'decimal' : undefined} className={k === 'pattern' ? 'mono' : undefined}
      placeholder={k === 'pattern' ? '^…$' : ''} />;
  };

  return (
    <section className="attr-panel" aria-labelledby="attr-head">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <h3 id="attr-head" className="attr-title">Field attributes</h3>
        <span className="small">Market profile: <strong>{marketName(layers.market)}</strong>
          <span className="muted"> · Product defaults → market profile → this bank</span></span>
      </div>
      <ChangeStatus result={result} what="The attribute change" />
      {error instanceof ApiError && error.status === 422 ? <Alert tone="error">{errorMessage(error)}</Alert> : <ErrorAlert error={error} onReload={load} />}
      <div className="table-wrap">
        <table className="table static compact attr-table">
          <caption className="sr-only">Attributes of {field.label}</caption>
          <thead><tr><th scope="col">Attribute</th><th scope="col">In force</th><th scope="col">From</th>{canEdit && <th scope="col">This bank</th>}</tr></thead>
          <tbody>
            {keys.map(k => (
              <tr key={k}>
                <th scope="row" className="attr-name"><label htmlFor={`attr-${k}`}>{LABEL[k]}</label></th>
                <td>{effText(k, (layers.effective as Record<string, unknown>)[k])}</td>
                <td>{source(k)}</td>
                {canEdit && <td className="attr-edit">{input(k)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dependsOn && (
        <div className="attr-cases">
          <p className="sub-head">Format by {depMeta?.label ?? dependsOn} {source('variants')}</p>
          <div className="table-wrap">
            <table className="table static compact">
              <caption className="sr-only">Format cases</caption>
              <thead><tr><th scope="col">When {depMeta?.label ?? dependsOn} is</th><th scope="col">Format</th><th scope="col">Example</th><th scope="col">Max length</th><th scope="col">Case</th>{canEdit && <th scope="col"><span className="sr-only">Remove</span></th>}</tr></thead>
              <tbody>
                {cases.map((c, i) => {
                  const set = (patch: Partial<CaseDraft>) => setCases(cs => cs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  if (c.removed) return <tr key={c.code} className="retired"><td>{caseLabel(c.code)}</td><td colSpan={4} className="muted small">No format check for this case</td>
                    {canEdit && <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ removed: false })}>Restore</button></td>}</tr>;
                  return (
                    <tr key={c.code}>
                      <td><strong>{caseLabel(c.code)}</strong><div className="muted small mono">{c.code}</div></td>
                      <td><input aria-label={`Format for ${caseLabel(c.code)}`} className="mono" value={c.pattern} disabled={!canEdit} onChange={e => set({ pattern: e.target.value })} /></td>
                      <td><input aria-label={`Example for ${caseLabel(c.code)}`} value={c.patternHint} disabled={!canEdit} onChange={e => set({ patternHint: e.target.value })} /></td>
                      <td><input aria-label={`Maximum length for ${caseLabel(c.code)}`} inputMode="decimal" value={c.maxLength} disabled={!canEdit} onChange={e => set({ maxLength: e.target.value.replace(/\D/g, '') })} style={{ width: 80 }} /></td>
                      <td>
                        <select aria-label={`Letter case for ${caseLabel(c.code)}`} value={c.transform} disabled={!canEdit} onChange={e => set({ transform: e.target.value })}>
                          <option value="">As typed</option><option value="upper">UPPER</option><option value="lower">lower</option>
                        </select>
                      </td>
                      {canEdit && <td><button type="button" className="icon-btn danger" aria-label={`Remove the case ${caseLabel(c.code)}`}
                        onClick={() => (c.isNew ? setCases(cs => cs.filter((_, j) => j !== i)) : set({ removed: true }))}>✕</button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canEdit && freeCodes.length > 0 && (
            <div className="picker-row">
              <label htmlFor="attr-add-case" className="sr-only">Add a case</label>
              <select id="attr-add-case" value="" onChange={e => { if (e.target.value) setCases(cs => [...cs, { code: e.target.value, pattern: '', patternHint: '', maxLength: '', transform: '', removed: false, isNew: true }]); }}>
                <option value="">+ Add a format for another {depMeta?.label ?? 'value'}…</option>
                {freeCodes.map(e => <option key={e.code} value={e.code}>{e.label}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="attr-test">
        <p className="sub-head">Test a value</p>
        <div className="picker-row">
          {preview.variants && (
            <select aria-label={`Test with ${depMeta?.label ?? 'case'}`} value={testCase} onChange={e => setTestCase(e.target.value)}>
              <option value="">No {depMeta?.label ?? 'case'} chosen</option>
              {Object.keys(preview.variants.cases).map(code => <option key={code} value={code}>{caseLabel(code)}</option>)}
            </select>
          )}
          <input aria-label="Value to test" value={testValue} onChange={e => setTestValue(e.target.value)} placeholder="Type a value" className={kind === 'text' ? 'mono' : undefined} />
        </div>
        {testValue && (testResult
          ? <p className="check-bad" role="status">✕ {testResult}</p>
          : <p className="check-ok" role="status">✓ Accepted{kind === 'text' && transformText(testValue, testRule) !== testValue ? <> — stored as <span className="mono">{transformText(testValue, testRule)}</span></> : null}</p>)}
      </div>

      {canEdit && (
        <div className="btn-row attr-actions">
          <span className="grow muted small">{dirty ? `This bank changes ${Object.keys(bankLayer).length} attribute${Object.keys(bankLayer).length === 1 ? '' : 's'}` : layers.tenant ? 'This bank has its own attributes' : 'Using the market profile and product defaults'}</span>
          <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy || !layers.tenant}>Reset to market / product</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save attributes'}</button>
        </div>
      )}
    </section>
  );
}
