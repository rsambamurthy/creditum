import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, type CreditRequestDetail, type CreditRequestInput, type FieldMeta, type FormValue, type Layout, type RuleMessage } from '../api';
import { useReference } from '../reference';
import { isNonZeroDecimal, isUnsignedDecimalText, scaleOf, trimDecimal } from '../format';
import { Field, Group } from './Field';
import { Alert, ErrorAlert, Spinner } from './Feedback';
import { FieldInput } from '../forms/FieldInput';
import { isDecimalText } from '../forms/formState';
import { checkValue, ruleFor, transformText, type FieldAttributes } from '../forms/attributes';

/** Attributes of the library field a header input is bound to (borrower name ← Name of Borrower, reference ← Customer Number). */
function boundField(layout: Layout | null, bind: 'borrowerName' | 'borrowerRef'): { key?: string; attrs?: FieldAttributes } {
  for (const m of layout?.modules ?? []) for (const s of m.sections) for (const f of s.fields) if (f.bind === bind) return { key: f.key, attrs: f.attrs };
  return {};
}

type Errors = Partial<Record<'borrowerName' | 'borrowerRef' | 'requestType' | 'currencyCode' | 'requestedAmount', string>>;

/** Editable fields of the New Credit Request form besides the header (the tenant chooses them on the Screen Layout page). */
export const formFields = (layout: Layout | null) => (layout?.createForm ?? []).filter(f => !f.readOnly && f.valueKind !== 'none');

export function RequestForm({ initial, submitLabel, onSubmit, onCancel, onReload }: {
  initial?: CreditRequestDetail;
  submitLabel: string;
  /** Persist; returns the rule warnings. Throws ApiError on failure. */
  onSubmit: (input: Partial<CreditRequestInput>) => Promise<RuleMessage[] | void>;
  onCancel: () => void;
  onReload?: () => void;
}) {
  const ref = useReference();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [layoutError, setLayoutError] = useState<unknown>(null);
  useEffect(() => { ref.loadLayout().then(setLayout).catch(setLayoutError); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const extra: FieldMeta[] = useMemo(() => formFields(layout), [layout]);
  const nameBound = useMemo(() => boundField(layout, 'borrowerName'), [layout]);
  const refBound = useMemo(() => boundField(layout, 'borrowerRef'), [layout]);
  const nameAttrs = nameBound.attrs;
  const refAttrs = refBound.attrs;
  const nameRule = ruleFor(nameAttrs, undefined);
  const refRule = ruleFor(refAttrs, undefined);

  const [borrowerName, setBorrowerName] = useState(initial?.borrowerName ?? '');
  const [borrowerRef, setBorrowerRef] = useState(initial?.borrowerRef ?? '');
  const [requestType, setRequestType] = useState(initial?.requestType ?? '');
  const [currencyCode, setCurrencyCode] = useState(initial?.currencyCode ?? '');
  const [amount, setAmount] = useState(initial ? trimDecimal(initial.requestedAmount) : '');
  // Values of the form's extra fields, as the API stores them (text, decimal text, YYYY-MM-DD, booleans).
  const [values, setValues] = useState<Record<string, FormValue>>(() => ({ ...((initial?.fields ?? {}) as Record<string, FormValue>) }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [ruleMessages, setRuleMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Defaults from configuration: base currency, first request type.
  useEffect(() => {
    if (!currencyCode && ref.baseCurrency) setCurrencyCode(ref.baseCurrency.code);
    if (!requestType && ref.requestTypes[0]) setRequestType(ref.requestTypes[0].code);
  }, [ref.baseCurrency, ref.requestTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = ref.currency(currencyCode);
  const minor = currency?.minorUnits;

  const validate = (): Errors => {
    const e: Errors = {};
    if (!borrowerName.trim()) e.borrowerName = 'Enter the borrower name';
    else { const why = checkValue(borrowerName.trim(), nameAttrs, 'text', undefined); if (why) e.borrowerName = why; }
    if (!borrowerRef.trim()) e.borrowerRef = 'Enter the borrower reference';
    else { const why = checkValue(borrowerRef.trim(), refAttrs, 'text', undefined); if (why) e.borrowerRef = why; }
    if (!requestType) e.requestType = 'Choose a request type';
    if (!currencyCode) e.currencyCode = 'Choose a currency';
    const a = amount.trim();
    if (!a) e.requestedAmount = 'Enter the requested amount';
    else if (!isUnsignedDecimalText(a)) e.requestedAmount = 'Use digits with an optional decimal point (no separators or symbols)';
    else if (!isNonZeroDecimal(a)) e.requestedAmount = 'The amount must be greater than zero';
    else if (minor !== undefined && scaleOf(a) > minor) e.requestedAmount = `${currencyCode} allows at most ${minor} decimal place${minor === 1 ? '' : 's'}`;
    return e;
  };

  const amountHint = useMemo(() => (minor === undefined ? undefined
    : `Up to ${minor} decimal place${minor === 1 ? '' : 's'} for ${currency?.name ?? currencyCode}. Type digits only, e.g. 1250000${minor ? `.${'5'.padEnd(minor, '0')}` : ''}.`), [minor, currency, currencyCode]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setServerError(null); setRuleMessages([]);
    const e = validate();
    setErrors(e); setFieldErrors({});
    const badNumbers = extra.filter(f => f.valueKind === 'decimal' && typeof values[f.key] === 'string' && (values[f.key] as string).trim() !== '' && !isDecimalText((values[f.key] as string).trim()));
    if (Object.keys(e).length || badNumbers.length) return;
    const input: Partial<CreditRequestInput> = {
      borrowerName: borrowerName.trim(), borrowerRef: borrowerRef.trim(), requestType, currencyCode, requestedAmount: amount.trim(),
    };
    // Only the form's own fields are sent; blank ones are sent only to clear a value that was there before.
    const fields: Record<string, FormValue> = {};
    for (const f of extra) {
      for (const k of f.valueKind === 'composite' && f.parts?.length ? f.parts.map(p => `${f.key}:${p}`) : [f.key]) {
        const v = values[k];
        const blank = v === undefined || v === null || v === '';
        const had = initial?.fields?.[k] !== undefined && initial?.fields?.[k] !== null && initial?.fields?.[k] !== '';
        if (!blank) fields[k] = typeof v === 'string' && f.valueKind === 'decimal' ? v.trim() : v;
        else if (had) fields[k] = null;
      }
    }
    if (Object.keys(fields).length) input.fields = fields;
    setBusy(true);
    try {
      await onSubmit(input);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'required_fields') {
        const fe: Record<string, string> = {};
        const other: string[] = [];
        for (const m of err.missingFields) {
          const onForm = extra.find(f => f.key === m.field);
          if (onForm) fe[m.field] = m.message; else other.push(`${m.field}: ${m.message}`);
        }
        setFieldErrors(fe); setRuleMessages(other);
        setServerError(new ApiError(err.status, err.code, 'Some information is required before this request can be saved.'));
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.has-error textarea, .has-error input, .has-error select')?.focus());
      } else if (err instanceof ApiError && err.code === 'invalid_value' && (err.details as { field?: string } | undefined)?.field) {
        // A field breaks its attributes (length, format, range): show the reason on that field.
        const f = (err.details as { field: string }).field;
        const why = err.message.replace(/^[^:]+:\s*/, '');
        if (f === nameBound.key || f === 'borrower_name') setErrors({ borrowerName: why });
        else if (f === refBound.key || f === 'borrower_ref') setErrors({ borrowerRef: why });
        else if (extra.some(x => x.key === f)) setFieldErrors({ [f]: why });
        else setServerError(err);
      } else if (err instanceof ApiError && ['amount_scale', 'invalid_amount', 'invalid_decimal'].includes(err.code)) {
        setErrors({ requestedAmount: err.message });
      } else {
        setServerError(err);
      }
    } finally {
      setBusy(false);
    }
  };


  return (
    <form onSubmit={submit} noValidate>
      {!!serverError && (serverError instanceof ApiError && serverError.code === 'required_fields'
        ? <Alert tone="error">{errorMessage(serverError)}{ruleMessages.length > 0 && <ul>{ruleMessages.map(m => <li key={m}>{m}</li>)}</ul>}</Alert>
        : <ErrorAlert error={serverError} onReload={onReload} />)}
      {ref.error ? <ErrorAlert error={ref.error} /> : null}
      <div className="section-groups">
        <Group title="Borrower">
          <div className="field-grid">
            <Field label="Borrower name" required error={errors.borrowerName}>
              <input value={borrowerName} onChange={e => setBorrowerName(transformText(e.target.value, nameRule))} maxLength={nameRule.maxLength ?? 250}
                placeholder={nameRule.placeholder ?? undefined} autoComplete="off" />
            </Field>
            <Field label="Borrower reference" required error={errors.borrowerRef}
              help={`Customer or CIF reference in the core banking system${refRule.patternHint ? ` · Format: ${refRule.patternHint}` : ''}${refRule.maxLength ? ` · up to ${refRule.maxLength} characters` : ''}`}>
              <input value={borrowerRef} onChange={e => setBorrowerRef(transformText(e.target.value, refRule))} maxLength={refRule.maxLength ?? 80}
                placeholder={refRule.placeholder ?? undefined} autoComplete="off" className="ltr" />
            </Field>
          </div>
        </Group>
        <Group title="Facility request">
          <div className="field-grid">
            <Field label="Request type" required error={errors.requestType}>
              <select value={requestType} onChange={e => setRequestType(e.target.value)}>
                {!requestType && <option value="">Choose…</option>}
                {ref.requestTypes.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Currency" required error={errors.currencyCode}>
              <select value={currencyCode} onChange={e => setCurrencyCode(e.target.value)}>
                {!currencyCode && <option value="">Choose…</option>}
                {ref.currencies.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}{c.isBase ? ' (base)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Requested amount" required error={errors.requestedAmount} help={amountHint}>
              <input value={amount} onChange={e => setAmount(e.target.value.replace(/\s/g, ''))} inputMode="decimal" autoComplete="off" placeholder="0" />
            </Field>
          </div>
        </Group>
        {layoutError ? <ErrorAlert error={layoutError} /> : !layout ? <Spinner label="Loading the form…" /> : extra.length > 0 && (
          <Group title="Request details">
            <div className="form-2col">
              {extra.map(f => (
                <FieldInput key={f.key} meta={f} values={values} layout={layout} disabled={busy}
                  header={{ borrowerName, borrowerRef }} message={fieldErrors[f.key]}
                  onChange={(k, v) => { setValues(x => ({ ...x, [k]: v })); setFieldErrors(x => { const n = { ...x }; delete n[k]; return n; }); }} />
              ))}
            </div>
            <p className="field-help" style={{ margin: '12px 0 0' }}>Everything else is entered on the module tabs after the request is saved.</p>
          </Group>
        )}
      </div>
      <div className="form-foot card" style={{ marginTop: 18, borderRadius: 12 }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !ref.loaded}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}
