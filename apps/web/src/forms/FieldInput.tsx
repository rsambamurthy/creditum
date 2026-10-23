/**
 * Generic editor for one layout field, chosen from its metadata (valueKind / dataType / list / calc / bind / display).
 * Nothing here knows a specific field key. Values are kept exactly as typed — decimals stay text.
 */
import { useId, type ReactNode } from 'react';
import type { FieldMeta, FormValue, Layout } from '../api';
import { formatDecimal, roundDecimalText } from '../format';
import { RichText } from '../components/RichText';
import { isDecimalText } from './formState';

export interface Header { borrowerName: string; borrowerRef: string }

export interface FieldInputProps {
  meta: FieldMeta;
  values: Record<string, FormValue>;
  onChange: (key: string, v: FormValue) => void;
  layout: Layout;
  header: Header;
  disabled: boolean;
  /** Element id used to scroll to this field (missing-field links). */
  domId?: string;
  missing?: boolean;
  /** Grid cell: no visible label (the column header labels it), compact control. */
  cell?: boolean;
  /** Accessible name when shown as a cell (e.g. "Revenue, Period 2"). */
  cellLabel?: string;
  /** A message from the server about this field (e.g. a rule's requirement). */
  message?: string;
  /** Show the value only (read-only view of an ordinary field, without the "Calculated" badge). */
  view?: boolean;
}

const PART_LABEL: Record<string, string> = { from: 'From', to: 'To', rate: 'Rate %' };

export const isDecimalField = (m: FieldMeta) => m.valueKind === 'decimal';
const isPercent = (m: FieldMeta) => m.dataType === 'Percentage';
export const isWide = (m: FieldMeta) => m.dataType === 'Rich Text' || m.dataType === 'Address (structured)' || m.valueKind === 'composite' || !!m.display;

/**
 * Display text of a decimal value. Calculated Percentage and Ratio values are rounded for display with the tenant's
 * configured places (string rounding); `full` carries the stored value for a tooltip when it differs.
 */
export function formatFieldDecimal(meta: FieldMeta, v: string, layout: Layout): { text: string; full?: string } {
  const places = !(meta.calc || meta.readOnly) ? undefined
    : meta.dataType === 'Percentage' ? layout.display?.percentagePlaces
      : meta.dataType === 'Ratio (decimal)' ? layout.display?.ratioPlaces : undefined;
  const suffix = isPercent(meta) ? ' %' : '';
  if (places === undefined) return { text: formatDecimal(v) + suffix };
  const text = formatDecimal(roundDecimalText(v, places), places) + suffix;
  const full = formatDecimal(v) + suffix;
  return full === text ? { text } : { text, full };
}

function displayValue(meta: FieldMeta, v: FormValue | undefined, layout: Layout): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (meta.valueKind === 'decimal' && isDecimalText(v)) {
    const d = formatFieldDecimal(meta, v, layout);
    return <span className="mono-num" title={d.full ? `Stored value: ${d.full}` : undefined}>{d.text}</span>;
  }
  if (meta.list) return layout.lists[meta.list]?.find(e => e.code === v)?.label ?? v;
  return v;
}

/** Read-only value of a calculated field, with its badge and formula description. */
function Calculated({ meta, value, cell, layout }: { meta: FieldMeta; value: FormValue | undefined; cell?: boolean; layout: Layout }) {
  const pending = meta.calc?.status === 'pending';
  const tip = [meta.calc?.description, meta.calc?.note].filter(Boolean).join(' — ');
  return (
    <div className={`calc-value${cell ? ' cell' : ''}${pending ? ' pending' : ''}`} title={tip || undefined}>
      {pending ? <span className="muted small">Formula pending approval</span> : displayValue(meta, value, layout)}
      {!cell && <span className="calc-badge" aria-label={tip ? `Calculated: ${tip}` : 'Calculated'}>Calculated</span>}
    </div>
  );
}

export function FieldInput(p: FieldInputProps) {
  const { meta, values, onChange, layout, header, disabled, cell } = p;
  const autoId = useId();
  const id = `${autoId}-in`;
  const helpId = `${autoId}-help`;
  const v = values[meta.key];
  const str = typeof v === 'string' ? v : '';
  const mandatory = meta.requirement === 'Mandatory' && !meta.readOnly && !meta.bind && !p.view;
  const decimalError = isDecimalField(meta) && str.trim() !== '' && !isDecimalText(str.trim());
  const describedBy = !cell && (meta.helpText || meta.calc) ? helpId : undefined;
  const common = { id, disabled, 'aria-describedby': describedBy, 'aria-invalid': decimalError || p.missing || p.message ? true : undefined,
    'aria-required': mandatory || undefined, 'aria-label': cell ? p.cellLabel ?? meta.label : undefined };

  // ---- display-only
  if (meta.display === 'heading') return cell ? <span className="strong">{meta.label}</span> : <h4 className="form-heading field-wide" id={p.domId}>{meta.label}</h4>;
  if (meta.display === 'chart' || meta.display === 'table') {
    return (
      <div className="placeholder-card field-wide" id={p.domId}>
        <span className="strong">{meta.label}</span>
        <span className="muted small">Available when the {meta.adapter ?? (meta.source && meta.source !== 'Calculated' ? `${meta.source.toLowerCase()} data source` : 'data source')} is connected</span>
      </div>
    );
  }

  let control: ReactNode;
  if (p.view && !meta.calc) {
    control = <div className="ro-value" id={id}>{displayValue(meta, v, layout)}</div>;
  } else if (meta.bind) {
    control = <div className="ro-value" id={id}>{header[meta.bind] || <span className="muted">—</span>}<span className="calc-badge">From request</span></div>;
  } else if (meta.calc || meta.readOnly) {
    control = <Calculated meta={meta} value={v} cell={cell} layout={layout} />;
  } else if (meta.valueKind === 'bool') {
    const opts: [string, FormValue][] = [['Yes', true], ['No', false], ['—', null]];
    control = (
      <div className="seg yesno" role="radiogroup" aria-label={cell ? p.cellLabel ?? meta.label : undefined} aria-labelledby={cell ? undefined : `${autoId}-lbl`} id={id}>
        {opts.map(([label, val]) => {
          const on = (v ?? null) === val;
          return <button key={label} type="button" role="radio" aria-checked={on} className={`seg-btn${on ? ' active' : ''}`} disabled={disabled}
            onClick={() => onChange(meta.key, val)} aria-label={val === null ? 'Not answered' : label}>{label}</button>;
        })}
      </div>
    );
  } else if (meta.valueKind === 'date') {
    control = <input type="date" value={str} onChange={e => onChange(meta.key, e.target.value || null)} {...common} />;
  } else if (meta.dataType === 'Currency Code') {
    control = (
      <select value={str} onChange={e => onChange(meta.key, e.target.value || null)} {...common}>
        <option value="">—</option>
        {layout.currencies.map(c => <option key={c.code} value={c.code}>{c.code}{c.code === layout.baseCurrency ? ' (base)' : ''}</option>)}
        {str && !layout.currencies.some(c => c.code === str) && <option value={str}>{str}</option>}
      </select>
    );
  } else if (meta.list && layout.lists[meta.list]) {
    const entries = layout.lists[meta.list];
    control = (
      <select value={str} onChange={e => onChange(meta.key, e.target.value || null)} {...common}>
        <option value="">—</option>
        {entries.map(e => <option key={e.code} value={e.code}>{e.label}</option>)}
        {str && !entries.some(e => e.code === str) && <option value={str}>{str} (inactive)</option>}
      </select>
    );
  } else if (meta.valueKind === 'composite') {
    const parts = meta.parts ?? [];
    control = (
      <div className="composite" role="group" aria-labelledby={cell ? undefined : `${autoId}-lbl`} aria-label={cell ? meta.label : undefined}>
        {parts.map(part => {
          const k = `${meta.key}:${part}`;
          const pv = typeof values[k] === 'string' ? (values[k] as string) : '';
          const bad = pv.trim() !== '' && !isDecimalText(pv.trim());
          return (
            <label key={part} className={`composite-part${bad ? ' has-error' : ''}`}>
              <span className="field-label">{PART_LABEL[part] ?? part}</span>
              <input value={pv} inputMode="decimal" disabled={disabled} aria-invalid={bad || undefined}
                onChange={e => onChange(k, e.target.value.replace(/\s/g, ''))} />
            </label>
          );
        })}
      </div>
    );
  } else if (isDecimalField(meta)) {
    const input = <input value={str} inputMode="decimal" autoComplete="off" onChange={e => onChange(meta.key, e.target.value.replace(/\s/g, ''))} {...common} />;
    control = isPercent(meta) ? <div className="suffix-input">{input}<span aria-hidden="true">%</span></div> : input;
  } else if (meta.dataType === 'Rich Text' && !cell) {
    control = <RichText value={str} onChange={x => onChange(meta.key, x)} id={id} disabled={disabled} aria-describedby={describedBy} aria-required={mandatory || undefined} maxLength={20000} />;
  } else if (meta.dataType === 'Address (structured)' && !cell) {
    control = <textarea rows={3} value={str} onChange={e => onChange(meta.key, e.target.value)} {...common} />;
  } else {
    control = <input value={str} onChange={e => onChange(meta.key, e.target.value)} autoComplete="off" {...common} />;
  }

  const listHint = meta.list && !layout.lists[meta.list] && !meta.readOnly ? 'No value list configured' : null;
  const error = decimalError ? 'Enter a number using digits and an optional decimal point' : p.message ?? null;
  const missingNote = !error && p.missing ? 'Required before submission' : null;

  if (cell) {
    return <div className={`cell-input${error ? ' has-error' : ''}${missingNote ? ' is-missing' : ''}`} id={p.domId} title={error ?? missingNote ?? listHint ?? undefined}>{control}</div>;
  }

  const labelEl = meta.valueKind === 'bool' || meta.valueKind === 'composite' || meta.calc || meta.readOnly || p.view
    ? <span className="field-label" id={`${autoId}-lbl`}>{meta.label}{mandatory && <span className="req" aria-hidden="true"> *</span>}</span>
    : <label htmlFor={id} id={`${autoId}-lbl`}>{meta.label}{mandatory && <span className="req" aria-hidden="true"> *</span>}{mandatory && <span className="sr-only"> (mandatory)</span>}</label>;

  return (
    <div className={`field${isWide(meta) ? ' field-wide' : ''}${error ? ' has-error' : ''}${p.missing ? ' is-missing' : ''}`} id={p.domId}>
      {labelEl}
      {control}
      {(meta.helpText || meta.calc?.description || listHint) && (
        <span className="field-help" id={helpId}>{meta.helpText ?? (meta.calc ? meta.calc.description : null)}{listHint && <>{meta.helpText ? ' · ' : ''}{listHint}</>}</span>
      )}
      {error && <span className="field-error" role="alert">{error}</span>}
      {missingNote && <span className="field-missing">{missingNote}</span>}
    </div>
  );
}
