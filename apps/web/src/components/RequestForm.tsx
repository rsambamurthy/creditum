import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, type CreditRequestDetail, type CreditRequestInput, type RuleMessage } from '../api';
import { useReference } from '../reference';
import { isNonZeroDecimal, isUnsignedDecimalText, scaleOf, trimDecimal } from '../format';
import { Field, Group } from './Field';
import { RichText } from './RichText';
import { Alert, ErrorAlert } from './Feedback';
import { RequirementBadge } from './Badge';

/** Registry key of the narrative captured with every request (label and requirement are tenant-configurable). */
export const CLIENT_DETAILS_KEY = 'a.client_request.client_request_details';

type Errors = Partial<Record<'borrowerName' | 'borrowerRef' | 'requestType' | 'currencyCode' | 'requestedAmount' | 'details', string>>;

export function RequestForm({ initial, submitLabel, onSubmit, onCancel, onReload }: {
  initial?: CreditRequestDetail;
  submitLabel: string;
  /** Persist; returns the rule warnings. Throws ApiError on failure. */
  onSubmit: (input: Partial<CreditRequestInput>) => Promise<RuleMessage[] | void>;
  onCancel: () => void;
  onReload?: () => void;
}) {
  const ref = useReference();
  const [fieldsReady, setFieldsReady] = useState(!!ref.fields);
  useEffect(() => { ref.loadFields().then(() => setFieldsReady(true)).catch(() => setFieldsReady(true)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const detailsField = ref.field(CLIENT_DETAILS_KEY);

  const [borrowerName, setBorrowerName] = useState(initial?.borrowerName ?? '');
  const [borrowerRef, setBorrowerRef] = useState(initial?.borrowerRef ?? '');
  const [requestType, setRequestType] = useState(initial?.requestType ?? '');
  const [currencyCode, setCurrencyCode] = useState(initial?.currencyCode ?? '');
  const [amount, setAmount] = useState(initial ? trimDecimal(initial.requestedAmount) : '');
  const initialDetails = initial?.fields?.[CLIENT_DETAILS_KEY];
  const [details, setDetails] = useState(typeof initialDetails === 'string' ? initialDetails : '');
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
    if (!borrowerRef.trim()) e.borrowerRef = 'Enter the borrower reference';
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
    setErrors(e);
    if (Object.keys(e).length) return;
    const input: Partial<CreditRequestInput> = {
      borrowerName: borrowerName.trim(), borrowerRef: borrowerRef.trim(), requestType, currencyCode, requestedAmount: amount.trim(),
    };
    if (details.trim() || (initial && typeof initialDetails === 'string')) input.fields = { [CLIENT_DETAILS_KEY]: details };
    setBusy(true);
    try {
      await onSubmit(input);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'required_fields') {
        const fe: Errors = {};
        const other: string[] = [];
        for (const m of err.missingFields) {
          if (m.field === CLIENT_DETAILS_KEY) fe.details = m.message; else other.push(`${ref.field(m.field)?.label ?? m.field}: ${m.message}`);
        }
        setErrors(fe); setRuleMessages(other);
        setServerError(new ApiError(err.status, err.code, 'Some information is required before this request can be saved.'));
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.has-error textarea, .has-error input')?.focus());
      } else if (err instanceof ApiError && ['amount_scale', 'invalid_amount', 'invalid_decimal'].includes(err.code)) {
        setErrors({ requestedAmount: err.message });
      } else {
        setServerError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const detailsLabel = detailsField?.label ?? 'Client Request Details';
  const showDetails = !detailsField?.hidden || !!errors.details || !!details;

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
              <input value={borrowerName} onChange={e => setBorrowerName(e.target.value)} maxLength={250} autoComplete="off" />
            </Field>
            <Field label="Borrower reference" required error={errors.borrowerRef} help="Customer or CIF reference in the core banking system">
              <input value={borrowerRef} onChange={e => setBorrowerRef(e.target.value)} maxLength={80} autoComplete="off" className="ltr" />
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
        {showDetails && (
          <Group title={detailsField?.group ?? 'Client request'}>
            <Field label={detailsLabel} wide error={errors.details}
              extra={detailsField ? <span style={{ marginInlineStart: 8, textTransform: 'none', letterSpacing: 0 }}><RequirementBadge value={detailsField.requirement} /></span> : undefined}
              help={detailsField?.helpText ?? (fieldsReady ? 'Describe what the client is asking for, the purpose and any context for the credit team. Required above the configured amount.' : undefined)}>
              <RichText value={details} onChange={setDetails} maxLength={20000} />
            </Field>
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
