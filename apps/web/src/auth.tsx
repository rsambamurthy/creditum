import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setToken, setUnauthenticatedHandler, type Me } from './api';

const TOKEN_KEY = 'creditum.token';

function readToken(): string | null {
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t: string | null) {
  try {
    if (t) window.sessionStorage.setItem(TOKEN_KEY, t); else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable (private mode / policy) — the session lives in memory only */ }
}

export const CREDIT_ROLES = ['relationship_officer', 'credit_analyst', 'credit_risk', 'committee_member', 'senior_committee_member',
  'executive_committee_member', 'credit_admin', 'auditor'];

interface AuthState {
  me: Me | null;
  status: 'loading' | 'signed-in' | 'signed-out';
  signIn: (tenantCode: string, loginName: string) => Promise<void>;
  signOut: () => void;
  hasRole: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState['status']>(() => (readToken() ? 'loading' : 'signed-out'));

  const signOut = useCallback(() => {
    setToken(null); writeToken(null); setMe(null); setStatus('signed-out');
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(signOut);
    const t = readToken();
    if (!t) return;
    setToken(t);
    api.me().then(m => { setMe(m); setStatus('signed-in'); }).catch(() => signOut());
    return () => setUnauthenticatedHandler(null);
  }, [signOut]);

  const signIn = useCallback(async (tenantCode: string, loginName: string) => {
    const { token } = await api.devLogin(tenantCode, loginName);
    setToken(token);
    const m = await api.me();
    writeToken(token);
    setMe(m);
    setStatus('signed-in');
  }, []);

  const hasRole = useCallback((...roles: string[]) => !!me && roles.some(r => me.roles.includes(r)), [me]);

  const value = useMemo(() => ({ me, status, signIn, signOut, hasRole }), [me, status, signIn, signOut, hasRole]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Signed-in user (pages under the app frame only). */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('Not signed in');
  return me;
}
