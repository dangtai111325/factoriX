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
import { NotFoundPage } from './pages/NotFound/NotFoundPage';

// Every page except the landing Overview is code-split, so the first load only carries the shell and Overview.
// Heavy libraries (graph, grid, charts) are pulled in by the page that uses them.
function lazyNamed<K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) {
  return React.lazy(() => load().then((m) => ({ default: m[name] })));
}
const FactoryStructurePage = lazyNamed(() => import('./pages/02_FactoryStructure/FactoryStructurePage'), 'FactoryStructurePage');
const KnowledgeGraphPage = lazyNamed(() => import('./pages/04_KnowledgeGraph/KnowledgeGraphPage'), 'KnowledgeGraphPage');
const ConnectionsPage = lazyNamed(() => import('./pages/05_Connections/ConnectionsPage'), 'ConnectionsPage');
const AddDataWizardPage = lazyNamed(() => import('./pages/06_AddDataWizard/AddDataWizardPage'), 'AddDataWizardPage');
const SignalsCatalogPage = lazyNamed(() => import('./pages/08_SignalsCatalog/SignalsCatalogPage'), 'SignalsCatalogPage');
const StorageManagementPage = lazyNamed(() => import('./pages/storage-management/StorageManagementPage'), 'StorageManagementPage');
const CreateStorageObjectWizard = lazyNamed(() => import('./pages/storage-management/wizards/CreateStorageObjectWizard'), 'CreateStorageObjectWizard');
const EditStorageObjectWizard = lazyNamed(() => import('./pages/storage-management/wizards/EditStorageObjectWizard'), 'EditStorageObjectWizard');
const BulkSubtablesWizard = lazyNamed(() => import('./pages/storage-management/wizards/BulkSubtablesWizard'), 'BulkSubtablesWizard');
const StorageObjectDetailPage = lazyNamed(() => import('./pages/storage-management/StorageObjectDetailPage'), 'StorageObjectDetailPage');
const HistorianExplorerPage = lazyNamed(() => import('./pages/historian/HistorianExplorerPage'), 'HistorianExplorerPage');
const DataModelsPage = lazyNamed(() => import('./pages/13_DataModels/DataModelsPage'), 'DataModelsPage');
const ComingSoonPage = lazyNamed(() => import('./pages/FutureModules/ComingSoonPage'), 'ComingSoonPage');
const DashboardListPage = lazyNamed(() => import('./pages/15_Dashboards/DashboardListPage'), 'DashboardListPage');
const DashboardViewPage = lazyNamed(() => import('./pages/15_Dashboards/DashboardViewPage'), 'DashboardViewPage');
const DashboardStudioPage = lazyNamed(() => import('./pages/15_Dashboards/studio/DashboardStudioPage'), 'DashboardStudioPage');

const PageLoading: React.FC = () => (
  <div role="status" aria-live="polite" className="flex items-center justify-center py-16 text-[13px] text-[#657794]">
    Loading…
  </div>
);

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

// Legacy catalog/:id -> /historian/storage/object/:id
const LegacyCatalogRedirect: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.replace('/historian/catalog/', '');
  return <Navigate to={`/historian/storage/object/${encodeURIComponent(id)}`} replace />;
};

const ROUTE_TITLES: Record<string, string> = {
  '/overview': 'Overview',
  '/factory/structure': 'Hierarchy Structure',
  '/factory/graph': 'Knowledge Graph',
  '/collector/connections': 'Connections',
  '/collector/add-data': 'Add Data',
  '/collector/signals': 'Signals',
  '/models': 'Data Models',
  '/dashboards': 'Dashboard',
  '/historian/storage': 'Storage Management',
  '/historian/historian': 'Historian',
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
    const title = matchedPath ? ROUTE_TITLES[matchedPath] : 'Page not found';
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
        <a href="#fx-main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:bg-white focus:px-3 focus:py-2 focus:rounded-lg focus:shadow-lg focus:text-[13px] focus:font-semibold focus:text-[#111B37]">
          Skip to content
        </a>
        <Topbar />
        <main id="fx-main-content" tabIndex={-1} className="fx-main outline-none">
          <div className="fx-content">
            <React.Suspense fallback={<PageLoading />}>
            <Routes>
              {/* Canonical Routes */}
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/factory/structure" element={<FactoryStructurePage />} />
              <Route path="/factory/graph" element={<KnowledgeGraphPage />} />
              <Route path="/collector/connections" element={<ConnectionsPage />} />
              <Route path="/collector/signals" element={<SignalsCatalogPage />} />
              <Route path="/collector/add-data" element={<AddDataWizardPage />} />
              <Route path="/models" element={<DataModelsPage />} />
              <Route path="/dashboards" element={<DashboardListPage />} />
              <Route path="/dashboards/:dashboardId" element={<DashboardViewPage />} />
              <Route path="/dashboards/:dashboardId/edit" element={<DashboardStudioPage />} />

              {/* Safe Redirects for Removed Product Features (Review 4 S5.4 / S5.8) */}
              <Route path="/factory/layout" element={<Navigate to="/factory/structure" replace />} />
              <Route path="/collector/edges" element={<Navigate to="/collector/connections" replace />} />
              <Route path="/collector/diagnostics" element={<Navigate to="/collector/connections" replace />} />

              {/* Storage & Historian Routes */}
              <Route path="/historian/storage" element={<StorageManagementPage />} />
              <Route path="/historian/storage/create" element={<CreateStorageObjectWizard />} />
              <Route path="/historian/storage/bulk" element={<BulkSubtablesWizard />} />
              <Route path="/historian/storage/edit/:objectId" element={<EditStorageObjectWizard />} />
              <Route path="/historian/storage/object/:objectId" element={<StorageObjectDetailPage />} />
              <Route path="/historian/historian" element={<HistorianExplorerPage />} />

              {/* Legacy query-preserving redirects */}
              <Route path="/historian/designer" element={<RedirectWithQuery to="/historian/storage" />} />
              <Route path="/historian/designer/:designId" element={<RedirectWithQuery to="/historian/storage" />} />
              <Route path="/historian/catalog" element={<RedirectWithQuery to="/historian/storage" extraParams={{ tab: 'objects' }} />} />
              <Route path="/historian/catalog/:id" element={<LegacyCatalogRedirect />} />
              <Route path="/historian" element={<RedirectWithQuery to="/historian/storage" />} />
              <Route path="/storage" element={<RedirectWithQuery to="/historian/storage" />} />
              <Route path="/historian/explorer" element={<RedirectWithQuery to="/historian/historian" />} />
              <Route path="/historian/policies" element={<RedirectWithQuery to="/historian/storage" extraParams={{ tab: 'objects' }} />} />
              <Route path="/historian/retention" element={<RedirectWithQuery to="/historian/storage" extraParams={{ tab: 'objects' }} />} />

              {/* Coming soon routes */}
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

              {/* R3-NAV-01: unknown routes get a real Not Found page instead of a silent redirect. */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </React.Suspense>
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
