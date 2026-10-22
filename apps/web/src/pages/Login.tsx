import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage, type DevUser } from '../api';
import { useAuth } from '../auth';
import { useDebounced } from '../hooks';
import { initials, rolesLabel } from '../format';
import { Alert, Spinner } from '../components/Feedback';

const DEFAULT_WORKSPACE = 'xyz-bank';

export function LoginPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const ws = useDebounced(workspace.trim().toLowerCase(), 300);
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => { document.title = 'Sign in · Creditum'; }, []);

  useEffect(() => {
    if (!ws) { setUsers(null); return; }
    let live = true;
    setUsers(null); setLoadError(null);
    api.devUsers(ws).then(u => { if (live) setUsers(u); }).catch(e => { if (live) { setLoadError(errorMessage(e)); setUsers([]); } });
    return () => { live = false; };
  }, [ws]);

  if (status === 'signed-in') return <Navigate to={from} replace />;

  const pick = async (u: DevUser) => {
    setBusy(u.loginName); setSignInError(null);
    try {
      await signIn(ws, u.loginName);
      navigate(from, { replace: true });
    } catch (e) {
      setSignInError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="center-page login-bg">
      <div className="card login-card split">
        <div className="login-side">
          <div className="brand brand-lg light">
            <span className="af-logo"><span className="af-mono">CR</span></span>
            <span>Creditum</span>
          </div>
          <h2>Corporate credit origination, configured — not coded.</h2>
          <p>One platform for relationship officers, analysts, risk and committees.</p>
          <ul>
            <li>Tenant-configured workflows and delegated authority</li>
            <li>Rules and field library maintained by your administrators</li>
            <li>Tamper-evident, hash-chained audit trail</li>
          </ul>
          <p className="small" style={{ marginTop: 'auto', paddingTop: 18, opacity: .7 }}>Integratatech.ai Pvt Ltd</p>
        </div>
        <div className="login-main">
          <h1>Sign in</h1>
          <p className="muted" style={{ marginTop: 0 }}>Choose your workspace, then your user.</p>
          <div className="alert alert-warning small" role="note">Development sign-in — bank deployments use the bank’s identity provider.</div>
          <div className="field">
            <label htmlFor="ws">Workspace ID</label>
            <input id="ws" value={workspace} onChange={e => setWorkspace(e.target.value)} autoComplete="organization" spellCheck={false}
              aria-describedby="ws-help" className="ltr" />
            <span className="field-help" id="ws-help">Reference workspaces: <code>xyz-bank</code> and <code>abc-finance</code>.</span>
          </div>
          {signInError && <div style={{ marginTop: 12 }}><Alert tone="error">{signInError}</Alert></div>}
          {loadError && <div style={{ marginTop: 12 }}><Alert tone="error">{loadError}</Alert></div>}
          {ws && users === null && <Spinner label="Loading users…" />}
          {users && users.length === 0 && !loadError && ws && <p className="muted" style={{ marginTop: 16 }}>No users found for workspace “{ws}”.</p>}
          {users && users.length > 0 && (
            <>
              <p className="sub-head" id="pick-head" style={{ marginTop: 18 }}>Sign in as</p>
              <div className="user-pick" role="list" aria-labelledby="pick-head">
                {users.map(u => (
                  <div role="listitem" key={u.loginName} style={{ display: 'contents' }}>
                    <button type="button" className="user-card" onClick={() => pick(u)} disabled={busy !== null}
                      aria-label={`Sign in as ${u.displayName}, ${rolesLabel(u.roles)}`}>
                      <span className="avatar" aria-hidden="true">{initials(u.displayName)}</span>
                      <span className="user-card-text">
                        <span className="me-name">{u.displayName}</span>
                        <span className="me-role">{busy === u.loginName ? 'Signing in…' : rolesLabel(u.roles)}</span>
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
