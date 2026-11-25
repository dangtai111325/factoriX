# FactoriX Web Console (`apps/web`)

Single-page application for the FactoriX appliance. In production it is built inside the `Dockerfile` (`npm run build`)
and served by the Center API from `FACTORIX_WEB_DIST` on the same port as the API (`:8080`), so the browser talks to
`/api/v1/*` and the live WebSocket `/stream` same-origin. Architecture and pages: see the root [`README.md`](../../README.md).

## Stack

React 18, TypeScript 5, Vite 5, TailwindCSS 3, React Router 6, ECharts 5 (charts), `@xyflow/react` + `elkjs`
(Knowledge Graph), `react-grid-layout` (Dashboard Studio canvas), `lucide-react` (icons). Versions: `package.json`.

## Scripts (`package.json`)

| Command | What it does |
|---|---|
| `npm ci` | Install the locked dependencies (`package-lock.json`) |
| `npm run dev` | Vite dev server on port 3000 (`--host`) |
| `npm run check` | Type check only (`tsc --noEmit`) — CI job `web-build` |
| `npm run build` | `tsc && vite build` into `dist/` — CI job `web-build` |
| `npm run preview` | Serve the built `dist/` on port 3000 |

## Dev server proxy (`vite.config.ts`)

| Path | Target | Override |
|---|---|---|
| `/api` | `http://127.0.0.1:8080` | `FACTORIX_BACKEND_TARGET` |
| `/ws` | `ws://127.0.0.1:8080` | `FACTORIX_WS_TARGET` |

The live stream client (`src/lib/liveStream.ts`) connects to `/stream` on the page's own host, and that path is not in
the proxy list, so in `npm run dev` live push does not reach the backend; the UI then falls back to REST polling
(`src/lib/connectivity.ts`). Use the appliance on `:8080` to check live behaviour.

## Layout (`src/`)

| Folder | Content |
|---|---|
| `App.tsx`, `main.tsx` | Routes (every page except Overview is lazy-loaded), auth guards, app shell |
| `api/` | Shared HTTP client |
| `components/` | `shell/` (Sidebar, Topbar, search), `modals/`, `charts/`, `tree/`, `common/` |
| `features/auth/` | Login, first-run setup (`/register`), password reset, auth context |
| `features/dashboard/` | Dashboard Studio: document model, widget registry and widgets, canvas, source picker, runtime |
| `lib/` | Live stream client, connectivity state, protocol and commissioning helpers, formatting |
| `pages/` | One folder per screen (below) |
| `store/AppContext.tsx` | App-wide state and live subscriptions |
| `types/`, `utils/` | Shared types and helpers |

## Pages (`src/pages/`)

| Folder | Route(s) |
|---|---|
| `01_Overview` | `/overview` |
| `02_FactoryStructure` | `/factory/structure` |
| `04_KnowledgeGraph` | `/factory/graph` |
| `05_Connections` | `/collector/connections` |
| `06_AddDataWizard` | `/collector/add-data` |
| `08_SignalsCatalog` | `/collector/signals` |
| `13_DataModels` | `/models` |
| `storage-management` | `/historian/storage`, `/historian/storage/create`, `/historian/storage/bulk`, `/historian/storage/edit/:objectId`, `/historian/storage/object/:objectId` |
| `historian` | `/historian/historian` |
| `15_Dashboards` | `/dashboards`, `/dashboards/:dashboardId`, `/dashboards/:dashboardId/edit` |
| `FutureModules` | "Coming soon" for `/alarms`, `/analytics`, `/reports`, `/administration` |
| `NotFound` | Any unknown route |

Older URLs (`/signals`, `/acquisition/*`, `/historian/explorer`, …) redirect to the routes above with their query string
kept (`App.tsx`). The widget types, limits and themes of the Dashboard Studio come from the backend
(`GET /api/v1/dashboards/widget-types`, contract `docs/architecture/contracts/dashboard.md`).
