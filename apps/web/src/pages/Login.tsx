import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage, type DevUser } from '../api';
import { useAuth } from '../auth';
import { useDebounced } from '../hooks';
import { initials, rolesLabel } from '../format';
import { Spinner } from '../components/Feedback';
import { Wordmark } from '../components/Wordmark';

const DEFAULT_WORKSPACE = 'xyz-bank';

/** Development sign-in in the house style: one narrow card, wordmark on top, a compact user list, one primary button. */
export function LoginPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const ws = useDebounced(workspace.trim().toLowerCase(), 300);
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [user, setUser] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = 'Sign in · Creditum'; }, []);
  useEffect(() => {
    if (!ws) { setUsers(null); return; }
    let live = true;
    setUsers(null); setUser(''); setError(null);
    api.devUsers(ws).then(u => { if (live) setUsers(u); }).catch(e => { if (live) { setError(errorMessage(e)); setUsers([]); } });
    return () => { live = false; };
  }, [ws]);

  if (status === 'signed-in') return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) { setError('Choose who you are signing in as'); return; }
    setBusy(true); setError(null);
    try { await signIn(ws, user); navigate(from, { replace: true }); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="signin-page">
      <main className="signin-card">
        <div className="signin-brand"><Wordmark size={30} /></div>
        <h1 className="signin-title">Sign in to your workspace</h1>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="ws">Workspace ID</label>
            <input id="ws" value={workspace} onChange={e => setWorkspace(e.target.value)} autoComplete="organization" spellCheck={false} className="ltr" aria-describedby="ws-help" />
            <span className="field-help" id="ws-help">Reference workspaces: xyz-bank, abc-finance</span>
          </div>
          <fieldset className="signin-users">
            <legend className="field-label">Sign in as</legend>
            {ws && users === null && <Spinner label="Loading users…" />}
            {users && users.length === 0 && !error && <p className="muted small" style={{ margin: '4px 0' }}>No users in workspace “{ws}”.</p>}
            {users && users.length > 0 && (
              <div className="user-list" role="radiogroup" aria-label="Users">
                {users.map(u => (
                  <label key={u.loginName} className={`user-row${user === u.loginName ? ' selected' : ''}`}>
                    <input type="radio" name="user" value={u.loginName} checked={user === u.loginName} onChange={() => { setUser(u.loginName); setError(null); }}
 />
                    <span className="avatar sm" aria-hidden="true">{initials(u.displayName)}</span>
                    <span className="user-row-text"><span className="me-name">{u.displayName}</span><span className="me-role">{rolesLabel(u.roles)}</span></span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {error && <p className="field-error" role="alert" style={{ margin: '0 0 10px' }}>{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !user}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="signin-dev" role="note">Development sign-in — bank deployments use the bank’s identity provider.</p>
        </form>
      </main>
      <footer className="signin-foot">Powered by <Wordmark size={14} /> · Integratatech.ai Pvt Ltd</footer>
    </div>
  );
}
