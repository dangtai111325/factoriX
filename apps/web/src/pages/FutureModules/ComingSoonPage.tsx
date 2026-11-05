import React from 'react';
import { useLocation, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Database,
  Bell,
  FileText,
  Settings,
  LineChart,
  ArrowRight,
  Clock,
  CheckCircle2,
} from 'lucide-react';

interface ComingSoonModule {
  title: string;
  valueProp: string;
  icon: React.ElementType;
  projectedFeatures: string[];
  inTheMeantime: {
    text: string;
    actionText: string;
    path: string;
  };
}

const COMING_SOON_MODULES: Record<string, ComingSoonModule> = {
  '/dashboards': {
    title: 'Dashboards',
    valueProp: 'Build real-time supervisory dashboards, operational KPI tiles, and production wallboards.',
    icon: LayoutDashboard,
    projectedFeatures: [
      'Configurable multi-metric gauges, line supervisory views, and equipment cards',
      'Drag-and-drop grid canvas with responsive layout scaling',
      'Real-time streaming telemetry powered by the collector pipeline',
      'Role-based dashboard workspaces and plant kiosk display modes',
    ],
    inTheMeantime: {
      text: 'View live machine telemetry and trend charts in the Live Monitor.',
      actionText: 'Open Signals Live Monitor',
      path: '/collector/signals?view=live',
    },
  },
  '/historian': {
    title: 'Historian & Storage',
    valueProp: 'High-density time-series historian storage, downsampling retention, and analytical querying.',
    icon: Database,
    projectedFeatures: [
      'High-throughput columnar time-series storage engine',
      'Automatic rolling downsampling and customizable data retention policies',
      'Fast historical range queries and query APIs for external BI systems',
      'Integrated cold storage data export and scheduled archive jobs',
    ],
    inTheMeantime: {
      text: 'Inspect 15-minute telemetry sparklines and export CSV data.',
      actionText: 'Open Signals Catalog',
      path: '/collector/signals',
    },
  },
  '/alarms': {
    title: 'Alarms & Events',
    valueProp: 'ISA-18.2 compliant industrial alarm management, deadbands, priority dispatch, and event tracking.',
    icon: Bell,
    projectedFeatures: [
      'Configurable high/low setpoint thresholds, rate-of-change, and deadband alarms',
      'Alarm shelving, acknowledgment tracking, and operator audit trail',
      'Multi-channel notification dispatch via email, webhooks, and push alerts',
      'Historical alarm frequency analysis and bad actor reporting',
    ],
    inTheMeantime: {
      text: 'Monitor connection health and live telemetry status in Connections.',
      actionText: 'Open Connections',
      path: '/collector/connections',
    },
  },
  '/analytics': {
    title: 'Analytics',
    valueProp: 'Overall Equipment Effectiveness (OEE), cycle time statistics, and anomaly detection models.',
    icon: LineChart,
    projectedFeatures: [
      'Automated OEE calculations: Availability, Performance, and Quality metrics',
      'Machine cycle time distribution and micro-stoppage root cause analysis',
      'Statistical process control (SPC) run charts with rule violation alerts',
      'Comparative line throughput benchmarks and shift productivity summaries',
    ],
    inTheMeantime: {
      text: 'Review message ingestion throughput and data quality in Overview.',
      actionText: 'Open Overview',
      path: '/overview',
    },
  },
  '/reports': {
    title: 'Reports',
    valueProp: 'Scheduled shift production reports, compliance summaries, and automated PDF delivery.',
    icon: FileText,
    projectedFeatures: [
      'Automated shift changeover reports and machine downtime tallies',
      'Pre-built PDF and Excel report templates for plant managers',
      'Scheduled recurring report generation with automated email delivery',
      'Compliance and data audit certification summaries',
    ],
    inTheMeantime: {
      text: 'Export filtered signal and telemetry tables to CSV.',
      actionText: 'Export from Signals Catalog',
      path: '/collector/signals',
    },
  },
  '/administration': {
    title: 'Administration',
    valueProp: 'Centralized plant administration, access control management, and appliance system diagnostics.',
    icon: Settings,
    projectedFeatures: [
      'Enterprise role-based access control (RBAC) and operator group permissions',
      'System backup, configuration export, and disaster recovery tools',
      'Multi-tenant network proxy settings and custom TLS certificate management',
      'Appliance resource monitoring, disk space management, and system updates',
    ],
    inTheMeantime: {
      text: 'Manage data connections and collector runtimes.',
      actionText: 'Open Connections',
      path: '/collector/connections',
    },
  },
};

const SUBFEATURE_INFO: Record<string, { moduleKey: string; name: string }> = {
  '/dashboards/library': { moduleKey: '/dashboards', name: 'Dashboard Library' },
  '/dashboards/builder': { moduleKey: '/dashboards', name: 'Dashboard Builder' },
  '/dashboards/widgets': { moduleKey: '/dashboards', name: 'Widget Library' },
  '/historian/explorer': { moduleKey: '/historian', name: 'Data Explorer' },
  '/historian/policies': { moduleKey: '/historian', name: 'Storage Policies' },
  '/historian/retention': { moduleKey: '/historian', name: 'Retention & Export' },
  '/alarms/rules': { moduleKey: '/alarms', name: 'Alarm Rules' },
  '/alarms/active': { moduleKey: '/alarms', name: 'Active Alarms' },
  '/alarms/history': { moduleKey: '/alarms', name: 'Event History' },
  '/analytics/workspace': { moduleKey: '/analytics', name: 'Analysis Workspace' },
  '/analytics/advanced': { moduleKey: '/analytics', name: 'Advanced Trends' },
  '/reports/library': { moduleKey: '/reports', name: 'Report Library' },
  '/reports/builder': { moduleKey: '/reports', name: 'Report Builder' },
  '/reports/schedules': { moduleKey: '/reports', name: 'Schedules' },
  '/administration/general': { moduleKey: '/administration', name: 'General Settings' },
  '/administration/users': { moduleKey: '/administration', name: 'Users & Roles' },
  '/administration/integrations': { moduleKey: '/administration', name: 'Integrations' },
  '/administration/audit': { moduleKey: '/administration', name: 'Audit Log' },
};

export const ComingSoonPage: React.FC = () => {
  const location = useLocation();
  const currentPath = location.pathname.toLowerCase();
  const subFeature = SUBFEATURE_INFO[currentPath];
  const matchedKey =
    subFeature?.moduleKey ||
    Object.keys(COMING_SOON_MODULES).find(
      (k) => currentPath === k || currentPath.startsWith(k + '/')
    ) ||
    currentPath;

  const moduleInfo =
    COMING_SOON_MODULES[matchedKey] || {
      title: 'Module Under Construction',
      valueProp: 'This industrial capability is planned for an upcoming FactoriX release.',
      icon: Clock,
      projectedFeatures: [
        'Dedicated industrial workflow configuration',
        'Integration with Unified Namespace telemetry',
        'Enterprise access control and audit logging',
      ],
      inTheMeantime: {
        text: 'Explore your factory structure and real-time data collection.',
        actionText: 'Go to Factory Structure',
        path: '/factory/structure',
      },
    };

  const Icon = moduleInfo.icon;

  return (
    <div className="max-w-4xl mx-auto py-10 px-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl border border-[#D4DFEC] shadow-sm p-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-bold bg-[#EEF5FF] text-[#1D63BD] border border-[#BED7F7]">
            <Clock className="w-3.5 h-3.5" />
            Coming soon
          </span>
        </div>

        <div className="flex items-start gap-5">
          <div className="p-3.5 rounded-xl bg-[#0B2545] text-white shrink-0 shadow-md">
            <Icon className="w-7 h-7" />
          </div>
          <div>
            {subFeature && (
              <div className="text-xs font-semibold text-blue-600 mb-1">
                {moduleInfo.title} › {subFeature.name}
              </div>
            )}
            <h1 className="text-[24px] font-extrabold text-[#111B37] tracking-tight">
              {subFeature ? subFeature.name : moduleInfo.title}
            </h1>
            <p className="text-[15px] text-[#475569] mt-2 leading-relaxed font-medium">
              {moduleInfo.valueProp}
            </p>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-[#E2E8F0]">
          <h2 className="text-[13px] font-bold uppercase tracking-wider text-[#94A3B8] mb-4">
            Planned Capabilities
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {moduleInfo.projectedFeatures.map((feature, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2.5 p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[13px] text-[#334568]"
              >
                <CheckCircle2 className="w-4 h-4 text-[#0B2545] shrink-0 mt-0.5" />
                <span>{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-[#E2E8F0] bg-[#F8FAFC] -mx-8 -mb-8 p-6 rounded-b-2xl flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-[13px] text-[#475569]">
            <span className="font-semibold text-[#111B37] mr-1.5">In the meantime:</span>
            <span>{moduleInfo.inTheMeantime.text}</span>
          </div>
          <Link
            to={moduleInfo.inTheMeantime.path}
            className="inline-flex items-center gap-2 px-4 py-2 text-[13px] font-semibold bg-white border border-[#CBD5E1] text-[#0B2545] hover:bg-[#F1F5F9] rounded-lg shadow-2xs transition-colors shrink-0"
          >
            <span>{moduleInfo.inTheMeantime.actionText}</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};
