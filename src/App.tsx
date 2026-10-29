import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/shell/Sidebar';
import { Topbar } from './components/shell/Topbar';
import { SearchModal } from './components/shell/SearchModal';

// 15 Core Screens
import { OverviewPage } from './pages/01_Overview/OverviewPage';
import { FactoryStructurePage } from './pages/02_FactoryStructure/FactoryStructurePage';
import { FactoryLayoutPage } from './pages/03_FactoryLayout/FactoryLayoutPage';
import { KnowledgeGraphPage } from './pages/04_KnowledgeGraph/KnowledgeGraphPage';
import { ConnectionsPage } from './pages/05_Connections/ConnectionsPage';
import { AddDataWizardPage } from './pages/06_AddDataWizard/AddDataWizardPage';
import { ProtocolStudioOPCPage } from './pages/07_ProtocolStudioOPC/ProtocolStudioOPCPage';
import { SignalsCatalogPage } from './pages/08_SignalsCatalog/SignalsCatalogPage';
import { CalculatedSignalsPage } from './pages/09_CalculatedSignals/CalculatedSignalsPage';
import { LiveOperationsPage } from './pages/10_LiveOperations/LiveOperationsPage';
import { DiagnosticsPage } from './pages/11_Diagnostics/DiagnosticsPage';
import { ActivityLogPage } from './pages/12_ActivityLog/ActivityLogPage';
import { OutputGroupsPage } from './pages/13_OutputGroups/OutputGroupsPage';
import { ProtocolStudioMQTTPage } from './pages/14_ProtocolStudioMQTT/ProtocolStudioMQTTPage';
import { ProtocolStudioHTTPPage } from './pages/15_ProtocolStudioHTTP/ProtocolStudioHTTPPage';

// Future Module Roadmaps
import { ComingSoonPage } from './pages/FutureModules/ComingSoonPage';

export const App: React.FC = () => {
  return (
    <div className="fx-app-shell">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        <main className="fx-main">
          <div className="fx-content">
            <Routes>
              {/* Default Redirect */}
              <Route path="/" element={<Navigate to="/overview" replace />} />

              {/* 15 Core Screen Routes */}
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/factory/structure" element={<FactoryStructurePage />} />
              <Route path="/factory/layout" element={<FactoryLayoutPage />} />
              <Route path="/factory/graph" element={<KnowledgeGraphPage />} />
              <Route path="/acquisition/connections" element={<ConnectionsPage />} />
              <Route path="/acquisition/add-data" element={<AddDataWizardPage />} />
              <Route path="/acquisition/studio/opcua" element={<ProtocolStudioOPCPage />} />
              <Route path="/signals" element={<SignalsCatalogPage />} />
              <Route path="/signals/calculated" element={<CalculatedSignalsPage />} />
              <Route path="/live/monitor" element={<LiveOperationsPage />} />
              <Route path="/live/diagnostics" element={<DiagnosticsPage />} />
              <Route path="/live/activity" element={<ActivityLogPage />} />
              <Route path="/signals/output-groups" element={<OutputGroupsPage />} />
              <Route path="/acquisition/studio/mqtt" element={<ProtocolStudioMQTTPage />} />
              <Route path="/acquisition/studio/http" element={<ProtocolStudioHTTPPage />} />

              {/* Future Modules */}
              <Route path="/dashboards" element={<ComingSoonPage />} />
              <Route path="/storage" element={<ComingSoonPage />} />
              <Route path="/alarms" element={<ComingSoonPage />} />
              <Route path="/reports" element={<ComingSoonPage />} />
              <Route path="/administration" element={<ComingSoonPage />} />

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </div>
        </main>
      </div>

      <SearchModal />
    </div>
  );
};
