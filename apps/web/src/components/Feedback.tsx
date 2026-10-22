import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../api';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div role="status" aria-live="polite"><div className="spinner" aria-hidden="true" /><span className="sr-only">{label}</span></div>;
}

export function Alert({ tone = 'info', children, action }: { tone?: 'info' | 'success' | 'warning' | 'error'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {action ? <div className="row-between" style={{ flexWrap: 'wrap' }}><div>{children}</div>{action}</div> : children}
    </div>
  );
}

/** Error alert for a failed API call; 409 conflicts offer a reload. */
export function ErrorAlert({ error, onReload }: { error: unknown; onReload?: () => void }) {
  if (!error) return null;
  const conflict = error instanceof ApiError && error.isConflict;
  return (
    <Alert tone={conflict ? 'warning' : 'error'} action={conflict && onReload ? <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>Reload</button> : undefined}>
      {conflict ? <><strong>Changed by someone else.</strong> {errorMessage(error)}</> : errorMessage(error)}
    </Alert>
  );
}

/** Loading / error / content switch for a useApi result. */
export function Loadable<T>({ state, children }: { state: { data: T | undefined; error: unknown; loading: boolean; reload: () => void }; children: (d: T) => ReactNode }) {
  if (state.error && state.data === undefined) return <ErrorAlert error={state.error} onReload={state.reload} />;
  if (state.data === undefined) return <Spinner />;
  return <>{children(state.data)}</>;
}

export function PageHead({ title, subtitle, actions, badge }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}{badge}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

export function NoAccess() {
  return <Alert tone="warning">Your role does not give access to this page. Ask a configuration administrator if you need it.</Alert>;
}

/** Outcome of a governed configuration write (maker-checker aware). */
export function ChangeStatus({ result, what }: { result: { status: 'applied' } | { status: 'pending'; changeId: string } | null; what?: string }) {
  if (!result) return null;
  return result.status === 'pending'
    ? <div className="alert alert-info" role="status"><strong>Pending approval by a second administrator.</strong> {what ? `${what} takes effect` : 'The change takes effect'} when another configuration administrator approves it under Configuration → Pending changes.</div>
    : <div className="alert alert-success" role="status"><strong>Applied.</strong> {what ? `${what} is` : 'The change is'} in effect now.</div>;
}
