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
import { FactoryLayoutPage } from './pages/03_FactoryLayout/FactoryLayoutPage';
import { KnowledgeGraphPage } from './pages/04_KnowledgeGraph/KnowledgeGraphPage';
import { ConnectionsPage } from './pages/05_Connections/ConnectionsPage';
import { AddDataWizardPage } from './pages/06_AddDataWizard/AddDataWizardPage';
import { OutputGroupsPage } from './pages/13_OutputGroups/OutputGroupsPage';
import { EdgesPage } from './pages/16_Edges/EdgesPage';
import { ComingSoonPage } from './pages/FutureModules/ComingSoonPage';
import { CollectorSignalsPage, CollectorDiagnosticsPage } from './pages/Collector/CollectorWorkspace';
import { ModelCatalogPage } from './pages/DataModels/ModelCatalogPage';
import { OutputGroupLivePage } from './pages/DataModels/OutputGroupLivePage';
import { legacyRoutes, legacyDestination } from './features/navigation/routes';

const LegacyRoute: React.FC = () => {
  const location = useLocation();
  return <Navigate replace to={legacyDestination(location.pathname, location.search, location.hash)} />;
};

const ProtectedAppShell: React.FC = () => (
  <AppProvider>
    <div className="fx-app-shell">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        <main className="fx-main">
          <div className="fx-content">
            <Routes>
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/factory/structure" element={<FactoryStructurePage />} />
              <Route path="/factory/layout" element={<FactoryLayoutPage />} />
              <Route path="/factory/graph" element={<KnowledgeGraphPage />} />
              <Route path="/collector/connections" element={<ConnectionsPage />} />
              <Route path="/collector/edges" element={<EdgesPage />} />
              <Route path="/collector/add-data" element={<AddDataWizardPage />} />
              <Route path="/collector/signals" element={<CollectorSignalsPage />} />
              <Route path="/collector/signals/live" element={<CollectorSignalsPage />} />
              <Route path="/collector/diagnostics" element={<CollectorDiagnosticsPage />} />
              <Route path="/collector/diagnostics/activity" element={<CollectorDiagnosticsPage />} />
              <Route path="/models" element={<ModelCatalogPage />} />
              <Route path="/models/designer" element={<OutputGroupsPage />} />
              <Route path="/models/live-preview" element={<OutputGroupLivePage />} />
              <Route path="/models/output-groups" element={<OutputGroupsPage />} />
              <Route path="/models/formulas" element={<ComingSoonPage />} />
              {Object.keys(legacyRoutes).map(path => <Route key={path} path={path} element={<LegacyRoute />} />)}
              {['opcua', 'mqtt', 'http'].map(protocol => <Route key={protocol} path={`/acquisition/studio/${protocol}`} element={<LegacyRoute />} />)}
              {['dashboards','historian','analytics','alarms','reports','administration'].map(module=><Route key={module} path={`/${module}/*`} element={<ComingSoonPage/>}/>)}
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
