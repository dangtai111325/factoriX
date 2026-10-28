import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "./theme/tokens.css";

import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./theme/ThemeContext";
import { ToastProvider } from "./components/ui/Toast";
import { Shell } from "./components/layout/Shell";

// Auth Pages
import { LoginPage } from "./pages/auth/Login";
import { BootstrapPage } from "./pages/auth/Bootstrap";
import { ForgotPasswordPage } from "./pages/auth/ForgotPassword";
import { ResetPasswordPage } from "./pages/auth/ResetPassword";

// Core Workspace Pages
import { OverviewPage } from "./pages/overview/OverviewPage";
import { TopologyPage } from "./pages/topology/TopologyPage";
import { GraphPage } from "./pages/topology/GraphPage";
import { ConnectionsPage } from "./pages/connectivity/ConnectionsPage";
import { EdgeFleetPage } from "./pages/edge/EdgeFleetPage";
import { StudioPage } from "./pages/studio/StudioPage";
import { HistorianPage } from "./pages/historian/HistorianPage";
import { DashboardsPage } from "./pages/dashboards/DashboardsPage";
import { SettingsPage } from "./pages/settings/SettingsPage";

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Auth Routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/bootstrap" element={<BootstrapPage />} />
            <Route path="/forgot" element={<ForgotPasswordPage />} />
            <Route path="/reset" element={<ResetPasswordPage />} />

            {/* Authenticated Industrial Operations Shell */}
            <Route element={<Shell />}>
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/topology" element={<TopologyPage />} />
              <Route path="/graph" element={<GraphPage />} />
              <Route path="/connectivity" element={<ConnectionsPage />} />
              <Route path="/edge" element={<EdgeFleetPage />} />
              <Route path="/studio" element={<StudioPage />} />
              <Route path="/historian" element={<HistorianPage />} />
              <Route path="/dashboards" element={<DashboardsPage />} />
              <Route path="/settings" element={<SettingsPage />} />

              {/* Legacy Aliases & Redirects */}
              <Route path="/factory" element={<Navigate to="/topology" replace />} />
              <Route path="/layouts" element={<Navigate to="/topology" replace />} />
              <Route path="/hierarchy" element={<Navigate to="/topology" replace />} />
              <Route path="/connections" element={<Navigate to="/connectivity" replace />} />
              <Route path="/commissioning" element={<Navigate to="/connectivity" replace />} />
              <Route path="/edges" element={<Navigate to="/edge" replace />} />
              <Route path="/deployments" element={<Navigate to="/edge" replace />} />
              <Route path="/signals" element={<Navigate to="/studio" replace />} />
              <Route path="/formulas" element={<Navigate to="/studio" replace />} />
              <Route path="/output-groups" element={<Navigate to="/studio" replace />} />
              <Route path="/storage" element={<Navigate to="/historian" replace />} />
              <Route path="/history" element={<Navigate to="/historian" replace />} />
              <Route path="/audit" element={<Navigate to="/settings" replace />} />
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
