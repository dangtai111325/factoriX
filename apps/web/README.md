# FactoriX Industrial IoT (IIoT) Platform — Modern Frontend

Welcome to the **FactoriX IIoT Platform** frontend repository. This application delivers a high-density, mission-critical operations console for factory asset hierarchy, industrial multi-protocol data acquisition, real-time telemetry streaming, and Unified Namespace (UNS) northbound publishing.

---

## 1. Architectural Highlights

- **Visual Theme**: Light Industrial Design System (`#F6F8FC` application canvas, crisp `#FFFFFF` cards, `#0F172A` high-contrast terminal insets, and signature FactoriX Red `#EF1B24` brand accent).
- **Domain Scope**: Built around ISA-95 hierarchical levels (`Enterprise` $\rightarrow$ `Site` $\rightarrow$ `Plant` $\rightarrow$ `Line` $\rightarrow$ `Machine` $\rightarrow$ `Sensor`).
- **Interactive Multi-Plant Switcher**: Real-time switching between operational sites (`Plant 01 CNC`, `Plant 02 Welding`, `Plant 03 Coating`, `Plant 04 Assembly`) across all dashboard screens.
- **Deterministic Demo Mode**: Built-in state machine simulator with 5 selectable scenarios (`healthy`, `degraded_modbus`, `timeout_opcua`, `auth_fail_mqtt`, `offline`) allowing comprehensive operational validation before backend integration.
- **Real-Time Telemetry & Micro-Sparklines**: 60-second vector wave sparklines embedded in table rows, high-frequency waveform charts, and live collector daemon health monitoring.

---

## 2. 15 Screen Core Navigation Map

| # | Route | Screen Name | Key Operational Capabilities |
|---|---|---|---|
| **01** | `/` | **Operations Overview** | Global factory telemetry KPIs, gateway connectivity donut chart, buffer status, and live event log. |
| **02** | `/factory/structure` | **Factory Structure** | ISA-95 asset hierarchy explorer, add resource modal, and move resource workflow with cycle validation and undo. |
| **03** | `/factory/layout` | **Layout Designer** | 2D visual CAD plant floor blueprint with snap-to-grid, pan/zoom, object placement, and power telemetry. |
| **04** | `/factory/graph` | **Knowledge Graph** | Contextual asset dependency graph, upstream sources, downstream telemetry consumers, and hop-depth filtering. |
| **05** | `/acquisition/connections` | **Industrial Connections** | Protocol gateways (Modbus TCP, OPC UA, MQTT, HTTP REST) with multi-stage diagnostics and latency ping tests. |
| **06** | `/acquisition/add-data` | **Add Data Wizard** | 4-step data acquisition setup: protocol selection, endpoint configuration, register mapping, and live sample read. |
| **07** | `/acquisition/studio/opcua` | **OPC UA Studio** | Server endpoint explorer, hierarchical node browsing, monitored item subscriptions, and security policy selection. |
| **08** | `/signals` | **Signals Catalog** | Central tag inventory with inline 60s micro-sparklines, slide-out inspector drawer, and floating sticky bulk action bar. |
| **09** | `/signals/calculated` | **Calculated Signals** | Deterministic mathematical AST formula evaluator, live test sliders, division-by-zero protection, and rule saver. |
| **10** | `/live/monitor` | **Live Monitor** | Dual-view operational console: high-frequency streaming matrix cards, telemetry waveform trendline, and parameter chips. |
| **11** | `/live/diagnostics` | **Diagnostics Center** | Root-cause troubleshooting workbench: dropped packet analysis, stage execution status, and raw trace logging. |
| **12** | `/live/activity` | **Activity Log** | Auditable security & operations event stream with severity filters and JSON event copy functionality. |
| **13** | `/signals/output-groups` | **Output Groups** | Unified Namespace (UNS) topic template builder, signal payload bundling, and live JSON projection preview. |
| **14** | `/acquisition/studio/mqtt` | **MQTT Mapping Studio** | 3-pane JSONPath telemetry mapper: raw broker payload, JSONPath extractor rules, and target signal schema. |
| **15** | `/acquisition/studio/http` | **HTTP REST Studio** | REST poll/push endpoint editor, bearer token authentication, request parameters, and response preview. |

---

## 3. Quick Start & Local Execution

### Prerequisites
- Node.js (v18+ recommended)
- npm or yarn
- Docker (optional, for standalone containerized deployment)

### Development Server
```bash
# Install dependencies
npm install

# Run type check
npm run check

# Start development server on port 3000
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build
```bash
# Compile TypeScript & generate production bundle
npm run build

# Preview production build locally
npm run preview
```

### Docker (appliance)
Use the repo root one-container package (web + Postgres + Center + Edge):
```bash
# from repo root
.\run-appliance.ps1
# or: docker compose up -d --build
```
Access the application on [http://127.0.0.1:8080](http://127.0.0.1:8080).

---

## 4. Quality Assurance & Screenshot Evidence

Full-resolution desktop screenshots (1672×941 and 1366×768) covering all 15 screens, modal dialogs, and interactive states are archived in:
- `artifacts/visual_qa_v2/`
- Interactive visual gallery: `artifacts/visual_qa_v2/gallery_v2.html`
