import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, CREDIT_ROLES, useAuth } from './auth';
import { ReferenceProvider } from './reference';
import { ToastProvider } from './components/Toast';
import { NoAccess, Spinner } from './components/Feedback';
import { AppFrame } from './layout/AppFrame';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { RequestsPage } from './pages/Requests';
import { NewRequestPage } from './pages/NewRequest';
import { RequestDetailPage } from './pages/RequestDetail';
import { FieldLibraryPage } from './pages/FieldLibrary';
import { ConfigurationPage } from './pages/Configuration';
import { RulesPage } from './pages/Rules';
import { WorkflowsPage } from './pages/Workflows';
import { AuditPage } from './pages/Audit';
import { ValueListsPage } from './pages/ValueLists';
import { FormulasPage } from './pages/Formulas';
import { ScreenLayoutPage } from './pages/ScreenLayout';
import { NotFoundPage } from './pages/NotFound';

function RequireAuth({ children }: { children: ReactNode }) {
  const { status, signedOutBy } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="center-page"><Spinner label="Signing in…" /></div>;
  // After an expired session the user comes back to the same page; after choosing to sign out, the next user starts fresh.
  if (status === 'signed-out') return <Navigate to="/login" replace state={signedOutBy === 'user' ? null : { from: location.pathname + location.search }} />;
  return <ReferenceProvider>{children}</ReferenceProvider>;
}

function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { hasRole } = useAuth();
  return hasRole(...roles) ? <>{children}</> : <div className="page"><NoAccess /></div>;
}

const ADMIN_READ = ['config_admin', 'auditor'];

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth><AppFrame /></RequireAuth>}>
            <Route index element={<DashboardPage />} />
            <Route path="requests" element={<RequireRole roles={CREDIT_ROLES}><RequestsPage /></RequireRole>} />
            <Route path="requests/new" element={<RequireRole roles={['relationship_officer']}><NewRequestPage /></RequireRole>} />
            <Route path="requests/:id" element={<RequireRole roles={CREDIT_ROLES}><RequestDetailPage /></RequireRole>} />
            <Route path="admin/fields" element={<RequireRole roles={ADMIN_READ}><FieldLibraryPage /></RequireRole>} />
            <Route path="admin/config" element={<RequireRole roles={ADMIN_READ}><ConfigurationPage /></RequireRole>} />
            <Route path="admin/value-lists" element={<RequireRole roles={ADMIN_READ}><ValueListsPage /></RequireRole>} />
            <Route path="admin/formulas" element={<RequireRole roles={['config_admin']}><FormulasPage /></RequireRole>} />
            <Route path="admin/layout" element={<RequireRole roles={['config_admin']}><ScreenLayoutPage /></RequireRole>} />
            <Route path="admin/rules" element={<RequireRole roles={ADMIN_READ}><RulesPage /></RequireRole>} />
            <Route path="admin/workflows" element={<RequireRole roles={ADMIN_READ}><WorkflowsPage /></RequireRole>} />
            <Route path="admin/audit" element={<RequireRole roles={ADMIN_READ}><AuditPage /></RequireRole>} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
