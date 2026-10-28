import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "./login";
import { CollectPage } from "./pages/collect";
import { FactoryPage } from "./pages/factory";
import { GraphPage } from "./pages/graph";
import { LayoutPage } from "./pages/layout";
import {
  AuditPage,
  CommissionPage,
  ConnectionsPage,
  DashboardPage,
  DeployPage,
  EdgePage,
  FormulaPage,
  HierarchyPage,
  HistoryPage,
  OutputPage,
  OverviewPage,
  PlannedPage,
  SettingsPage,
  SignalsPage,
  StoragePage,
} from "./screens";
import { Shell } from "./shell";
import "./styles.css";

function App() {
  useEffect(() => {
    const saved = localStorage.getItem("fx-theme");
    if (saved === "dark") document.documentElement.dataset.theme = "dark";
  }, []);
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Shell />}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/factory" element={<FactoryPage />} />
          <Route path="/layouts" element={<LayoutPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/hierarchy" element={<HierarchyPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/signals" element={<SignalsPage />} />
          <Route path="/formulas" element={<FormulaPage />} />
          <Route path="/output-groups" element={<OutputPage />} />
          <Route path="/commissioning" element={<CommissionPage />} />
          <Route path="/collect" element={<CollectPage />} />
          <Route path="/edges" element={<EdgePage />} />
          <Route path="/deployments" element={<DeployPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/dashboards" element={<DashboardPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/planned/:slug" element={<PlannedPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
