import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

/**
 * Labelled form control. The label is bound to the control via id; help and error text are linked
 * with aria-describedby, and the control is marked aria-invalid on error.
 */
export function Field({ label, children, help, error, required, wide, extra }: {
  label: ReactNode; children: ReactElement<Record<string, unknown>>; help?: ReactNode; error?: ReactNode; required?: boolean; wide?: boolean; extra?: ReactNode;
}) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, 'aria-required': required || undefined })
    : children;
  return (
    <div className={`field${wide ? ' field-wide' : ''}${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true"> *</span>}{extra}</label>
      {control}
      {help && <span className="field-help" id={helpId}>{help}</span>}
      {error && <span className="field-error" id={errId}>{error}</span>}
    </div>
  );
}

/** Read-only value in the grey box style. */
export function ReadOnly({ label, children, wide, mono }: { label: ReactNode; children: ReactNode; wide?: boolean; mono?: boolean }) {
  const id = useId();
  const empty = children === null || children === undefined || children === '';
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label" id={id}>{label}</span>
      <div className={`ro-value${mono ? ' mono-num' : ''}`} aria-labelledby={id} role="group">{empty ? <span className="muted">—</span> : children}</div>
    </div>
  );
}

/** Fieldset with the accent-bar legend. */
export function Group({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <fieldset className="group">
      <legend>
        <span className="grow">{title}</span>
        {actions}
      </legend>
      {children}
    </fieldset>
  );
}
