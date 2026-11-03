import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Database,
  Bell,
  FileText,
  Settings,
  ArrowRight,
  Sparkles,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';

interface ModuleMeta {
  title: string;
  tagline: string;
  icon: React.ElementType;
  description: string;
  roadmapPhase: string;
  plannedFeatures: string[];
}

const moduleDirectory: Record<string, ModuleMeta> = {
  '/acquisition/studio/opcua': {
    title: 'Protocol Studio · OPC UA',
    tagline: 'Browse OPC UA address spaces and map nodes into signals.',
    icon: Layers,
    description:
      'Protocol Studio is not active in this appliance build. Use Add Data Wizard to create OPC UA connections, commission the endpoint, and activate mapped signals through the collector.',
    roadmapPhase: 'Coming next · Protocol browse & map',
    plannedFeatures: [
      'Live OPC UA node tree browse against a commissioned endpoint',
      'Drag selected nodes into signal mappings',
      'Security policy and certificate picker',
      'Save mappings into the same activation path as Add Data Wizard',
    ],
  },
  '/acquisition/studio/mqtt': {
    title: 'Protocol Studio · MQTT',
    tagline: 'Inspect broker payloads and map JSONPath fields into signals.',
    icon: Layers,
    description:
      'MQTT Studio is not active yet. Create MQTT connections and topic mappings from Add Data Wizard so the collector owns the live path.',
    roadmapPhase: 'Coming next · Protocol browse & map',
    plannedFeatures: [
      'Live topic subscription preview',
      'JSONPath extractor rules with sample payloads',
      'QoS and retained-message controls',
      'Activation into the collector config release',
    ],
  },
  '/acquisition/studio/http': {
    title: 'Protocol Studio · HTTP',
    tagline: 'Poll REST endpoints and project response fields into signals.',
    icon: Layers,
    description:
      'HTTP Studio is not active yet. Configure HTTP poll connections from Add Data Wizard for a working collector path.',
    roadmapPhase: 'Coming next · Protocol browse & map',
    plannedFeatures: [
      'Request builder with auth headers',
      'Response JSONPath mapping',
      'Interval and timeout controls',
      'Activation into the collector config release',
    ],
  },
  '/signals/calculated': {
    title: 'Calculated Signals',
    tagline: 'Formula workbench for derived industrial measurements.',
    icon: Sparkles,
    description:
      'Calculated signal rules are not persisted in this appliance build. Collect raw signals through Add Data Wizard first; formula rules arrive with the next signals workstream.',
    roadmapPhase: 'Coming next · Formula engine',
    plannedFeatures: [
      'AST formula editor with live preview',
      'Unit-aware derived signals',
      'Division-by-zero and missing-value guards',
      'Publish calculated signals into output groups',
    ],
  },
  '/dashboards': {
    title: 'Executive & Operational Dashboards',
    tagline: 'Self-service widget builder, line supervision, and custom telemetry tiles.',
    icon: LayoutDashboard,
    description:
      'The Dashboard builder consumes observations published by the Data Collector and unified namespace topics. It is decoupled from raw hardware ingestion to guarantee zero telemetry overhead on the collection loop.',
    roadmapPhase: 'FactoriX Workstream 5 · Studio & Visualization',
    plannedFeatures: [
      'Multi-gauge and real-time sparkline visualization widgets',
      'Drag-and-drop grid canvas with responsive card layouts',
      'Operator role-based dashboard workspaces and sharing',
      'Direct link to Factory Model hierarchy and assets',
    ],
  },
  '/storage': {
    title: 'Time-Series Historian & Cold Storage',
    tagline: 'Long-term telemetry archival, downsampling, and persistent historian databases.',
    icon: Database,
    description:
      'In the current Data Collector version, telemetry is buffered in high-performance in-memory ring buffers. Dedicated cold storage utilizes Apache IoTDB / TimescaleDB for multi-year historical trend retention.',
    roadmapPhase: 'FactoriX Workstream 4 · Historian Infrastructure',
    plannedFeatures: [
      'Configurable retention policies (raw, 1m downsampled, 1h summary)',
      'Time-series partition management and SSD/cold tiering',
      'Historical query API with high throughput aggregate rollups',
      'Automatic backup to cloud or on-premise S3 object storage',
    ],
  },
  '/alarms': {
    title: 'Alarms, Events & ISA-18.2 Management',
    tagline: 'High-priority threshold alarms, operator acknowledgement, and escalation workflows.',
    icon: Bell,
    description:
      'Industrial alarms are managed through strict ISA-18.2 lifecycle state machines. Alarm thresholds will trigger notifications via SMS, Email, and webhook escalations without stalling OT poll loops.',
    roadmapPhase: 'FactoriX Workstream 6 · Incident & Notification Engine',
    plannedFeatures: [
      'Static, dynamic and deviation alarm thresholds',
      'Alarm shelving, suppression, and operator acknowledgement',
      'Audited event rationalization and root cause logging',
      'Escalation rosters with on-call engineer shifts',
    ],
  },
  '/reports': {
    title: 'Automated Reports & Production Insights',
    tagline: 'Scheduled shift summaries, downtime Pareto charts, and exportable PDF/Excel briefs.',
    icon: FileText,
    description:
      'Automated shift reporting aggregates collector observations and MES production orders to calculate OEE, availability, and energy consumption metrics.',
    roadmapPhase: 'FactoriX Workstream 7 · Business Intelligence',
    plannedFeatures: [
      'Scheduled shift change PDF generation and automated email delivery',
      'Energy usage and carbon footprint compliance templates',
      'Custom KPI aggregations across plants, lines and work centers',
      'Export to Excel (XLSX), CSV and enterprise BI data lakes',
    ],
  },
  '/administration': {
    title: 'Enterprise Administration & RBAC',
    tagline: 'User directory, single sign-on, role permissions, and audit governance.',
    icon: Settings,
    description:
      'The current local development candidate runs in single-operator mode. Enterprise administration incorporates Keycloak OAuth2 / OIDC, granular resource-level access control, and compliance auditing.',
    roadmapPhase: 'FactoriX Foundation · Identity & Governance',
    plannedFeatures: [
      'Keycloak Single Sign-On (SSO) with LDAP / Active Directory sync',
      'Role-based permissions: Operator, Plant Engineer, System Admin',
      'Audit log trail for all configuration activations and rollbacks',
      'API token management and rate limiting quotas',
    ],
  },
};

export const ComingSoonPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const meta =
    moduleDirectory[location.pathname] || {
      title: 'Planned FactoriX Module',
      tagline: 'Scheduled for upcoming release in the FactoriX Smart Manufacturing roadmap.',
      icon: Sparkles,
      description: 'This module is scheduled according to the FactoriX Architecture Roadmap.',
      roadmapPhase: 'Future Roadmap Item',
      plannedFeatures: ['Upcoming feature suite in active design phase'],
    };

  const Icon = meta.icon;

  return (
    <div className="space-y-6 max-w-4xl mx-auto py-8 animate-in fade-in duration-200">
      {/* Header Banner */}
      <div className="text-center space-y-3">
        <div className="w-16 h-16 rounded-2xl bg-[#FFF0F1] border border-[#FAC6C9] mx-auto flex items-center justify-center text-[#EF1B24] shadow-sm">
          <Icon className="w-8 h-8" />
        </div>
        <div className="inline-block px-3 py-1 rounded-full bg-[#EEF5FF] text-[#2A82E7] font-bold text-[12px] border border-[#D4DFEC]">
          {meta.roadmapPhase}
        </div>
        <h1 className="text-[28px] font-extrabold text-[#111B37] tracking-tight">{meta.title}</h1>
        <p className="text-[15px] text-[#657794] max-w-xl mx-auto leading-relaxed">{meta.tagline}</p>
      </div>

      {/* Architectural Context Card */}
      <Card title="Architectural Role & Scope" className="p-6">
        <p className="text-[14px] text-[#334568] leading-relaxed mb-6">{meta.description}</p>

        <h3 className="text-[13px] font-bold text-[#111B37] uppercase tracking-wider mb-3">
          Planned Core Capabilities:
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {meta.plannedFeatures.map((feat, idx) => (
            <div
              key={idx}
              className="p-3.5 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3] flex items-start gap-3"
            >
              <span className="w-2 h-2 rounded-full bg-[#EF1B24] mt-1.5 flex-shrink-0" />
              <span className="text-[13px] font-semibold text-[#111B37]">{feat}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Return to Core Collector Action Bar */}
      <div className="p-5 rounded-2xl bg-white border border-[#D4DFEC] shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h4 className="text-[14px] font-bold text-[#111B37]">
            Return to Active OT Data Collection
          </h4>
          <p className="text-[12px] text-[#657794]">
            Explore the live collector engine, telemetry streaming, or factory layout.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            onClick={() => navigate('/overview')}
            icon={<ArrowRight className="w-4 h-4" />}
          >
            Overview
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              navigate(
                location.pathname.startsWith('/acquisition/studio') || location.pathname === '/signals/calculated'
                  ? '/acquisition/add-data'
                  : '/live/monitor',
              )
            }
            icon={<ArrowRight className="w-4 h-4" />}
          >
            {location.pathname.startsWith('/acquisition/studio') || location.pathname === '/signals/calculated'
              ? 'Add Data Wizard'
              : 'Live Monitor'}
          </Button>
        </div>
      </div>
    </div>
  );
};
