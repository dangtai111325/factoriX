import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import {
  ForgotPasswordPage,
  GuestOnly,
  LoginPage,
  RegisterPage,
  RequireAuth,
  ResetPasswordPage,
  useAuth,
} from './features/auth';
import { AppProvider } from './store/AppContext';
import { Sidebar } from './components/shell/Sidebar';
import { Topbar } from './components/shell/Topbar';
import { SearchModal } from './components/shell/SearchModal';

import { OverviewPage } from './pages/01_Overview/OverviewPage';
import { FactoryStructurePage } from './pages/02_FactoryStructure/FactoryStructurePage';
import { KnowledgeGraphPage } from './pages/04_KnowledgeGraph/KnowledgeGraphPage';
import { ConnectionsPage } from './pages/05_Connections/ConnectionsPage';
import { AddDataWizardPage } from './pages/06_AddDataWizard/AddDataWizardPage';
import { SignalsCatalogPage } from './pages/08_SignalsCatalog/SignalsCatalogPage';
import { OutputGroupsPage } from './pages/13_OutputGroups/OutputGroupsPage';
import { ComingSoonPage } from './pages/FutureModules/ComingSoonPage';

// Query-preserving redirect helper (TC-UI-NAV-06)
const RedirectWithQuery: React.FC<{ to: string; extraParams?: Record<string, string> }> = ({
  to,
  extraParams,
}) => {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  if (extraParams) {
    for (const [key, val] of Object.entries(extraParams)) {
      searchParams.set(key, val);
    }
  }
  const query = searchParams.toString();
  const destination = query ? `${to}?${query}` : to;
  return <Navigate to={destination} replace />;
};

const ROUTE_TITLES: Record<string, string> = {
  '/overview': 'Overview',
  '/factory/structure': 'Hierarchy Structure',
  '/factory/graph': 'Knowledge Graph',
  '/collector/connections': 'Connections',
  '/collector/add-data': 'Add Data',
  '/collector/signals': 'Signals',
  '/models': 'Model Catalog',
  '/dashboards': 'Dashboards',
  '/historian': 'Historian & Storage',
  '/alarms': 'Alarms & Events',
  '/analytics': 'Analytics',
  '/reports': 'Reports',
  '/admin': 'Administration',
};

const PageTitleUpdater: React.FC = () => {
  const location = useLocation();
  React.useEffect(() => {
    const matchedPath = Object.keys(ROUTE_TITLES).find((path) => location.pathname.startsWith(path));
    const title = matchedPath ? ROUTE_TITLES[matchedPath] : 'FactoriX';
    document.title = `${title} · FactoriX`;
  }, [location.pathname]);
  return null;
};

const ProtectedAppShell: React.FC = () => (
  <AppProvider>
    <PageTitleUpdater />
    <div className="fx-app-shell">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        <main className="fx-main">
          <div className="fx-content">
            <Routes>
              {/* Canonical Routes */}
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/factory/structure" element={<FactoryStructurePage />} />
              <Route path="/factory/graph" element={<KnowledgeGraphPage />} />
              <Route path="/collector/connections" element={<ConnectionsPage />} />
              <Route path="/collector/signals" element={<SignalsCatalogPage />} />
              <Route path="/collector/add-data" element={<AddDataWizardPage />} />
              <Route path="/models" element={<OutputGroupsPage />} />

              {/* Safe Redirects for Removed Product Features (Review 4 S5.4 / S5.8) */}
              <Route path="/factory/layout" element={<Navigate to="/factory/structure" replace />} />
              <Route path="/collector/edges" element={<Navigate to="/collector/connections" replace />} />
              <Route path="/collector/diagnostics" element={<Navigate to="/collector/connections" replace />} />

              {/* Coming soon routes */}
              <Route path="/dashboards/*" element={<ComingSoonPage />} />
              <Route path="/dashboards" element={<ComingSoonPage />} />
              <Route path="/historian/*" element={<ComingSoonPage />} />
              <Route path="/historian" element={<ComingSoonPage />} />
              <Route path="/alarms/*" element={<ComingSoonPage />} />
              <Route path="/alarms" element={<ComingSoonPage />} />
              <Route path="/analytics/*" element={<ComingSoonPage />} />
              <Route path="/analytics" element={<ComingSoonPage />} />
              <Route path="/reports/*" element={<ComingSoonPage />} />
              <Route path="/reports" element={<ComingSoonPage />} />
              <Route path="/administration/*" element={<ComingSoonPage />} />
              <Route path="/administration" element={<ComingSoonPage />} />

              {/* Legacy Route Redirects with preserved Query Parameters (§2.3 & TC-UI-NAV-06) */}
              <Route path="/topology" element={<RedirectWithQuery to="/factory/structure" />} />
              <Route path="/factory-layout" element={<RedirectWithQuery to="/factory/structure" />} />
              <Route path="/knowledge-graph" element={<RedirectWithQuery to="/factory/graph" />} />
              <Route path="/acquisition/connections" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/acquisition/edges" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/acquisition/add-data" element={<RedirectWithQuery to="/collector/add-data" />} />
              <Route path="/acquisition/studio/mqtt" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/acquisition/studio/opc" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/acquisition/studio/opcua" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/acquisition/studio/http" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/signals" element={<RedirectWithQuery to="/collector/signals" />} />
              <Route path="/live/monitor" element={<RedirectWithQuery to="/collector/signals" extraParams={{ view: 'live' }} />} />
              <Route path="/live/diagnostics" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/live/activity" element={<RedirectWithQuery to="/collector/connections" />} />
              <Route path="/signals/output-groups" element={<RedirectWithQuery to="/models" />} />
              <Route path="/signals/calculated" element={<RedirectWithQuery to="/models" extraParams={{ tab: 'calculations' }} />} />
              <Route path="/storage" element={<RedirectWithQuery to="/historian" />} />

              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </div>
        </main>
      </div>
      <SearchModal />
    </div>
  </AppProvider>
);

const RootRedirect: React.FC = () => {
  const { state, isFirstRun } = useAuth();
  if (state.status === 'checking') {
    return (
      <div className="min-h-screen bg-[#F6F8FC] flex items-center justify-center text-[#657794]">
        Opening FactoriX…
      </div>
    );
  }
  if (state.status === 'authenticated') return <Navigate to="/overview" replace />;
  return <Navigate to={isFirstRun ? '/register' : '/login'} replace />;
};

export const App: React.FC = () => (
  <Routes>
    <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
    <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
    <Route path="/forgot-password" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
    <Route path="/reset-password" element={<GuestOnly><ResetPasswordPage /></GuestOnly>} />
    <Route path="/" element={<RootRedirect />} />
    <Route
      path="/*"
      element={(
        <RequireAuth>
          <ProtectedAppShell />
        </RequireAuth>
      )}
    />
  </Routes>
);
