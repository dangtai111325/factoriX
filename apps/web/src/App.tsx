import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
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
import { SignalsCatalogPage } from './pages/08_SignalsCatalog/SignalsCatalogPage';
import { LiveOperationsPage } from './pages/10_LiveOperations/LiveOperationsPage';
import { DiagnosticsPage } from './pages/11_Diagnostics/DiagnosticsPage';
import { ActivityLogPage } from './pages/12_ActivityLog/ActivityLogPage';
import { OutputGroupsPage } from './pages/13_OutputGroups/OutputGroupsPage';
import { ComingSoonPage } from './pages/FutureModules/ComingSoonPage';

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
              <Route path="/acquisition/connections" element={<ConnectionsPage />} />
              <Route path="/acquisition/add-data" element={<AddDataWizardPage />} />
              <Route path="/acquisition/studio/opcua" element={<ComingSoonPage />} />
              <Route path="/signals" element={<SignalsCatalogPage />} />
              <Route path="/signals/calculated" element={<ComingSoonPage />} />
              <Route path="/live/monitor" element={<LiveOperationsPage />} />
              <Route path="/live/diagnostics" element={<DiagnosticsPage />} />
              <Route path="/live/activity" element={<ActivityLogPage />} />
              <Route path="/signals/output-groups" element={<OutputGroupsPage />} />
              <Route path="/acquisition/studio/mqtt" element={<ComingSoonPage />} />
              <Route path="/acquisition/studio/http" element={<ComingSoonPage />} />
              <Route path="/dashboards" element={<ComingSoonPage />} />
              <Route path="/storage" element={<ComingSoonPage />} />
              <Route path="/alarms" element={<ComingSoonPage />} />
              <Route path="/reports" element={<ComingSoonPage />} />
              <Route path="/administration" element={<ComingSoonPage />} />
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
