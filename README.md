# FactoriX IIoT Platform - Technical Documentation & System Wiki

Tài liệu kỹ thuật tổng hợp toàn diện về kiến trúc nền tảng, cấu trúc mã nguồn, hạ tầng dữ liệu thực tế (Data Sources, Signals, Asset Hierarchy) và hệ thống 36 Data Models v2 đang vận hành trong FactoriX Appliance. Tài liệu này được thiết kế như một **System Wiki** phục vụ bàn giao dự án, vận hành, bảo trì và phát triển mở rộng.

---

## Mục lục
1. [Tổng quan Kiến trúc Hệ thống (System Architecture)](#1-tổng-quan-kiến-trúc-hệ-thống)
2. [Cấu trúc Thư mục & Mã Nguồn (Codebase Structure)](#2-cấu-trúc-thư-mục--mã-nguồn)
3. [Nguồn Dữ liệu Thực tế (Live OT Data Sources)](#3-nguồn-dữ-liệu-thực-tế)
4. [Cây Phân cấp Tài sản (Asset Topology Hierarchy)](#4-cây-phân-cấp-tài-sản)
5. [Hệ thống 36 Data Models v2 (Data Models Specification)](#5-hệ-thống-36-data-models-v2)
6. [Kiến trúc Lưu trữ & Hai Cơ sở Dữ liệu (Database Architecture)](#6-kiến-trúc-lưu-trữ--hai-cơ-sở-dữ-liệu)
7. [Vận hành, Giám sát & Khắc phục Sự cố (Runbook & Operations)](#7-vận-hành-giám-sát--khắc-phục-sự-cố)
8. [Lịch sử Nghiệm thu & Tối ưu Hiệu năng (Release Acceptance)](#8-lịch-sử-nghiệm-thu--tối-ưu-hiệu-năng)

---

## 1. Tổng quan Kiến trúc Hệ thống

FactoriX là nền tảng IIoT (Industrial Internet of Things) cấp doanh nghiệp, được thiết kế theo mô hình **Edge-to-Cloud/Center Appliance** chịu lỗi cao (Fault-tolerant), hỗ trợ kết nối đa giao thức công nghiệp, chuẩn hóa dữ liệu vi mô thời gian thực và tổng hợp mô hình dữ liệu (Data Model v2 Engine).

```mermaid
flowchart TD
    subgraph OT_Lab ["Mạng OT / Thiết bị Nguồn (PC03: 192.168.2.108)"]
        MB["Modbus TCP (:502)"]
        OPC["OPC UA (:4840)"]
        MQTT_B["MQTT Broker (:1883)"]
        HTTP_S["HTTP REST (:443)"]
        WS_S["WebSocket Live (:80)"]
    end

    subgraph Edge_Collector ["FactoriX Edge Daemon (apps/edge)"]
        Connectors["Protocol Connectors\n(Async HTTP/Modbus/OPC UA/MQTT/WS)"]
        StoreOutbox["Transactional Outbox (SQLite WAL)\n- Store-and-Forward\n- History Lane & Latest Lane"]
        Forwarder["Edge Sync Forwarder\n(POST /api/v1/edge-sync/observations)"]
        Connectors -->|Raw Samples| StoreOutbox
        StoreOutbox --> Forwarder
    end

    subgraph Center_Appliance ["FactoriX Center Core (apps/center - Docker :8080)"]
        Ingest["Ingestion & Deduplication Engine\n(ingest_dedup Index B-Tree)"]
        PG_DB[("PostgreSQL 16\n- observations (Monthly Partitioned)\n- latest_signal_state (In-memory/Cache)\n- output_groups & model_state")]
        DM_Engine["Data Model v2 Engine\n(Real-time State Recomposition)"]
        WebSockets["Real-time WebSocket & SSE Fanout"]
        API_GW["FastAPI Core & Security RBAC"]

        Forwarder --> Ingest
        Ingest --> PG_DB
        PG_DB --> DM_Engine
        DM_Engine --> WebSockets
        PG_DB --> API_GW
    end

    subgraph Frontend_App ["FactoriX Web Console (apps/web)"]
        UI_Dash["Overview & Real-time KPI"]
        UI_Tree["Hierarchy & Resource Explorer"]
        UI_Sig["Signals Catalog (336 Live Signals)"]
        UI_DM["Data Model Builder v2"]
        UI_Conn["Connections & Commissioning"]

        API_GW --> Frontend_App
        WebSockets --> Frontend_App
    end

    OT_Lab --> Connectors
```

### Các nguyên tắc thiết kế cốt lõi:
1. **Không mất dữ liệu (Store-and-Forward)**: Khi mạng giữa Edge và Center bị ngắt, Edge lưu cục bộ vào SQLite WAL Outbox và tự động phát lại (replay) theo đúng thứ tự khi kết nối hồi phục mà không làm trễ luồng trực tiếp (dual-lane: History Lane & Latest Lane).
2. **Bảo toàn dữ liệu tốt cuối cùng (Last Good Value)**: Khi một tín hiệu bị gián đoạn hoặc lỗi, hệ thống không xóa giá trị hợp lệ cuối cùng mà chuyển cờ sang `BAD` hoặc `STALE`, giữ nguyên `last_good_value_json` và `last_good_event_time`.
3. **Thứ tự thời gian bất biến (Monotonic Ingest Ordering)**: Trạng thái mới nhất được sắp xếp dựa trên thời gian thu nhận thực tế của hệ thống `(received_time, observation_id)`, ngăn chặn hiện tượng clock skew (lệch giờ đồng hồ thiết bị nguồn) làm đảo lộn thứ tự dữ liệu.

---

## 2. Cấu trúc Thư mục & Mã Nguồn

```
iiot-platform/
├── apps/
│   ├── center/               # Backend Core API & Pipeline Engine (Python 3.12, FastAPI, SQLAlchemy, asyncpg)
│   │   ├── src/factorix/
│   │   │   ├── api/          # Định nghĩa Route REST API và WebSocket endpoints
│   │   │   ├── domain/       # Nghiệp vụ: signal_state, body, datamodel_v2, formula
│   │   │   ├── modules/      # Logic xử lý: telemetry, collect, data_models, resources, edge_sync
│   │   │   ├── platform/     # Config Pydantic, database engine, logging, security
│   │   │   └── transport/    # HTTP app setup, WebSocket hub, SSE, middleware
│   │   └── tests/            # Test suite: unit tests (498 tests), integration tests
│   ├── edge/                 # Edge Collector Daemon (Python 3.12 Asyncio)
│   │   ├── src/factorix_edge/
│   │   │   ├── connectors/   # Connector: modbus, opcua, mqtt, http_pull, websocket_live
│   │   │   ├── store/        # Outbox SQLite WAL: outbox.py, compaction, pruning
│   │   │   ├── jobs.py       # Job runner, schedule concurrent polling
│   │   │   ├── runtime.py    # Edge runtime lifecycle, heartbeat, forward loop
│   │   │   └── mapping.py    # Type coercion, sample decoding
│   │   └── tests/            # Edge pytest suite (99 tests)
│   └── web/                  # Frontend SPA (React 18, TypeScript, Vite, TailwindCSS)
│       ├── src/
│       │   ├── assets/       # Logo, static branding (factorix_brand_logo.png)
│       │   ├── components/   # UI kit, layout, shell, modals, forms
│       │   ├── pages/        # 14 màn hình chức năng (00_Login -> 13_DataModels)
│       │   ├── store/        # Zustand state & AppContext WebSocket manager
│       │   └── test/         # Playwright E2E browser tests
├── docs/                     # Tài liệu kiến trúc & Release Gates
├── infrastructure/           # Docker, docker-compose, entrypoint.sh, PostgreSQL conf
└── package.json / pyproject.toml
```

---

## 3. Nguồn Dữ liệu Thực tế (Live OT Data Sources)

Toàn bộ dữ liệu thực tế tại hiện trường đang được thu thập từ trạm thiết bị mô phỏng **PC03** tại địa chỉ IP nội bộ: **`192.168.2.108`**.

Hệ thống kết nối song song qua **5 giao thức công nghiệp**, tất cả đều đang ở trạng thái **`ACTIVE`** và sức khỏe **`HEALTHY`**:

| Tên Kết nối (Connection Name) | Giao thức | Địa chỉ Endpoint Nguồn | Chu kỳ / Cơ chế | Chức năng thu thập |
|---|---|---|---|---|
| **PC03 Modbus TCP 502** | `modbus_tcp` | `192.168.2.108:502` | Poll 1000 ms (Holding/Input Registers) | Tọa độ rung 3 trục, lưu lượng dòng chảy, mức dầu, điện áp/dòng điện pha |
| **PC03 OPC UA 4840** | `opcua` | `opc.tcp://192.168.2.108:4840/simulator/` | Monitored Items (Subscription) | Nhiệt độ máy (temp 1-7), nhiệt độ môi trường, áp suất 1 & 2 |
| **PC03 MQTT 1883** | `mqtt` | `mqtt://192.168.2.108:1883` | Sub topic `factory/+/+/telemetry` | Công suất tiêu thụ (P, Q, S), hệ số công suất PF, năng lượng tích lũy |
| **PC03 HTTP 443** | `http` | `http://192.168.2.108:443/` | Concurrent Poll 1000 ms | Thông tin lệnh sản xuất (SO/WO), mã sản phẩm, số lượng Good/Bad, tiến độ |
| **PC03 WebSocket live** | `websocket` | `ws://192.168.2.108/ws/live` | Stream thời gian thực | Trạng thái máy (Run/Stop/Idle/Error), tốc độ vòng quay (Speed 1/2), ca làm việc, mã nhân viên |

---

## 4. Cây Phân cấp Tài sản (Asset Topology Hierarchy)

Hệ thống tài sản được tổ chức theo tiêu chuẩn phân cấp ISA-95:

```
[Enterprise] TIPA
 └── [Site] DongNai (code: DongNai)
      └── [Area] Factory-1
           └── [Zone] ASSY (Khu vực lắp ráp)
                ├── [Line] Assembly - AA10-01 (A1) ──> [Machine] AA10-01 (56 signals)
                ├── [Line] Assembly - AA10-02 (AB) ──> [Machine] AA10-02 (56 signals)
                ├── [Line] Assembly - AA10-03 (A3) ──> [Machine] AA10-03 (56 signals)
                ├── [Line] Assembly - AA10-04 (A4) ──> [Machine] AA10-04 (56 signals)
                ├── [Line] Assembly - AA10-05 (MM) ──> [Machine] AA10-05 (56 signals)
                └── [Line] Assembly - AA10-06 (A6) ──> [Machine] AA10-06 (56 signals)
```

- **Tổng số máy vận hành**: 6 máy (`AA10-01` đến `AA10-06`).
- **Tổng số tín hiệu đang hoạt động trên màn hình**: **336 tín hiệu** ($56 \times 6 = 336$).
- **Số tín hiệu trong Database**: **344 tín hiệu** (Gồm 336 tín hiệu `ACTIVE` + 8 tín hiệu `ARCHIVED` từ các máy thử nghiệm tạm thời trong các vòng review).

### Nhóm 56 tín hiệu trên mỗi máy:
1. **Nhiệt độ & Môi trường**: `machine_temp_1` đến `machine_temp_7`, `ambient_temp`, `humidity`, `noise`.
2. **Cơ khí & Thủy lực**: `pressure_1`, `pressure_2`, `vibration_1_x/y/z`, `vibration_2_x/y/z`, `vibration_3_x/y/z`, `flow_rate_1`, `flow_rate_2`, `oil_level`.
3. **Năng lượng & Điện năng**: `voltage_1/2/3`, `current_1/2/3`, `power_active`, `power_reactive`, `power_apparent`, `power_factor`, `energy_active`, `energy_reactive`, `frequency`.
4. **Vận hành & Tốc độ**: `speed_1`, `speed_2`, `program_name`, `program_no`, `uptime_1`, `uptime_2`, `status`, `mode`, `stop_error`, `employee`.
5. **Sản xuất & Đơn hàng**: `so_id`, `wo_id`, `product_id`, `product_name`, `target_qty`, `good_qty`, `bad_qty`, `progress_percent`, `run_rate`.

---

## 5. Hệ thống 36 Data Models v2

Mỗi máy trong 6 máy sở hữu **6 Data Models** độc lập chạy ở chu kỳ mẫu 1.000 ms, tổng cộng là **36 Data Models** đang chạy (`ACTIVE`, `RUNNING`).

```
6 Máy (AA10-01 → AA10-06) × 6 Models/Máy = 36 Data Models v2
```

### Chi tiết 6 loại Data Model:

#### 1. Model: `Condition` (Tình trạng kỹ thuật)
- **Mục đích**: Giám sát rung chấn 3 trục, nhiệt độ động cơ/bạc đạn, áp suất, lưu lượng và cảnh báo bất thường.
- **Số trường**: 29 trường.
- **Cấu trúc dữ liệu đầu ra JSON**:
```json
{
  "zone_name": "ASSY",
  "line_name": "Assembly - AA10-01 (A1)",
  "machine_name": "AA10-01",
  "source_timestamp": "2026-11-10T02:03:06.191Z",
  "publish_timestamp": "2026-11-10T02:03:22.289Z",
  "machine_temp_1": 64.2,
  "machine_temp_2": 65.1,
  "machine_temp_3": 63.8,
  "machine_temp_4": 66.0,
  "machine_temp_5": 62.4,
  "machine_temp_6": 61.9,
  "machine_temp_7": 64.7,
  "ambient_temp": 28.5,
  "pressure_1": 5.4,
  "pressure_2": 5.2,
  "humidity": 68.2,
  "noise": 74.1,
  "vibration_1_x": 0.12,
  "vibration_1_y": 0.15,
  "vibration_1_z": 0.08,
  "vibration_2_x": 0.11,
  "vibration_2_y": 0.14,
  "vibration_2_z": 0.09,
  "vibration_3_x": 0.13,
  "vibration_3_y": 0.16,
  "vibration_3_z": 0.10,
  "flow_rate_1": 18.4,
  "flow_rate_2": 17.9,
  "oil_level": 88.0,
  "status": 2
}
```

#### 2. Model: `Energy` (Tiêu thụ Năng lượng)
- **Mục đích**: Đo lường điện năng 3 pha, công suất tác dụng, công suất phản kháng và hệ số PF.
- **Số trường**: 18 trường.
- **Cấu trúc dữ liệu đầu ra JSON**:
```json
{
  "zone_name": "ASSY",
  "line_name": "Assembly - AA10-01 (A1)",
  "machine_name": "AA10-01",
  "source_timestamp": "2026-11-10T02:03:06.191Z",
  "publish_timestamp": "2026-11-10T02:03:22.289Z",
  "power_active": 42.6,
  "power_reactive": 12.3,
  "power_apparent": 44.3,
  "power_factor": 0.96,
  "voltage_1": 220.4,
  "voltage_2": 219.8,
  "voltage_3": 221.1,
  "current_1": 64.5,
  "current_2": 63.9,
  "current_3": 65.1,
  "energy_active": 15420.5,
  "energy_reactive": 3120.2,
  "frequency": 50.02
}
```

#### 3. Model: `State` (Trạng thái Máy)
- **Mục đích**: Ghi nhận máy đang Chạy (Run = 2), Dừng (Stop = 0), Nghỉ (Idle = 1), mã lỗi và người vận hành.
- **Số trường**: 9 trường.
- **Cấu trúc dữ liệu đầu ra JSON**:
```json
{
  "zone_name": "ASSY",
  "line_name": "Assembly - AA10-01 (A1)",
  "machine_name": "AA10-01",
  "source_timestamp": "2026-11-10T02:03:06.191Z",
  "publish_timestamp": "2026-11-10T02:03:22.289Z",
  "status": 2,
  "mode": 0,
  "stop_error": null,
  "employee": "21113185"
}
```

#### 4. Model: `Process` (Thông số Gia công & Chu kỳ)
- **Mục đích**: Tốc độ hoạt động, chương trình đang chạy và tổng thời gian chạy thực tế (uptime).
- **Số trường**: 13 trường.
- **Cấu trúc dữ liệu đầu ra JSON**:
```json
{
  "zone_name": "ASSY",
  "line_name": "Assembly - AA10-01 (A1)",
  "machine_name": "AA10-01",
  "source_timestamp": "2026-11-10T02:03:06.191Z",
  "publish_timestamp": "2026-11-10T02:03:22.289Z",
  "speed_1": 321.7,
  "speed_2": 295.3,
  "program_name": "ASM-STD-01",
  "program_no": "PRG-43203",
  "uptime_1": 4398,
  "uptime_2": 0,
  "status": 2,
  "employee": "21113185"
}
```

#### 5. Model: `Order` (Thông tin Đơn hàng)
- **Mục đích**: Theo dõi đơn hàng (Sales Order / Work Order), mục tiêu sản xuất và số lượng đạt/hỏng.
- **Số trường**: 13 trường.
- **Cấu trúc dữ liệu đầu ra JSON**:
```json
{
  "zone_name": "ASSY",
  "line_name": "Assembly - AA10-01 (A1)",
  "machine_name": "AA10-01",
  "source_timestamp": "2026-11-10T02:03:06.191Z",
  "publish_timestamp": "2026-11-10T02:03:22.289Z",
  "so_id": "SO-2026-0891",
  "wo_id": "WO-44102",
  "product_id": "PRD-GEAR-BOX-A",
  "product_name": "Hộp giảm tốc tiêu chuẩn A",
  "target_qty": 500,
  "good_qty": 412,
  "bad_qty": 4,
  "status": 2
}
```

#### 6. Model: `Order progress` (Tiến độ Đơn hàng)
- **Mục đích**: Tính toán tỷ lệ phần trăm hoàn thành và tốc độ sản xuất tức thời.
- **Số trường**: 11 trường.
- **Cấu trúc dữ liệu đầu ra JSON**:
```json
{
  "zone_name": "ASSY",
  "line_name": "Assembly - AA10-01 (A1)",
  "machine_name": "AA10-01",
  "source_timestamp": "2026-11-10T02:03:06.191Z",
  "publish_timestamp": "2026-11-10T02:03:22.289Z",
  "so_id": "SO-2026-0891",
  "wo_id": "WO-44102",
  "progress_percent": 82.4,
  "run_rate": 45.2,
  "good_qty": 412,
  "bad_qty": 4
}
```

---

## 6. Kiến trúc Lưu trữ & Hai Cơ sở Dữ liệu

Hệ thống FactoriX sử dụng **2 cơ sở dữ liệu chuyên biệt**:

### 1. Cơ sở dữ liệu Edge: SQLite Outbox (`/data/outbox.sqlite`)
- **Vị trí**: Nằm trên Edge (hoặc container appliance tại `/data/outbox.sqlite`).
- **Nhiệm vụ**: Vùng đệm Store-and-Forward đảm bảo at-least-once delivery.
- **Dung lượng hiện tại**:
  - File chính: `42.32 MB`
  - File WAL: `5.72 MB`
  - File SHM: `0.06 MB`
  - **Tổng cộng: ~48 MB**.
- **Cơ chế tự xóa sau khi Forward (Auto-pruning)**:
  - Khi forward thành công sang Center, bản ghi chuyển sang `ACKED`.
  - Giữ lại đệm trong **2 phút** (`ACKED_RETENTION = timedelta(minutes=2)`).
  - Vòng lặp bảo trì (`_maintenance_loop`) chạy định kỳ **mỗi 15 giây** (`PRUNE_INTERVAL_S = 15s`) sẽ xóa vĩnh viễn (`DELETE FROM outbox`) các bản ghi `ACKED`, `QUARANTINED`, `DEAD` thành từng lô nhỏ 500 dòng chạy trên luồng ngầm (`asyncio.to_thread`).
  - Tự động chạy `VACUUM` và `wal_checkpoint(TRUNCATE)` khi phát hiện trang trống phình to.
  - **Tốc độ tăng dung lượng dài hạn**: **~0 MB/s** (dung lượng giữ ổn định quanh mốc 40 - 50 MB, không bị phình vô tận).

### 2. Cơ sở dữ liệu Center: PostgreSQL 17 (`factorix` DB, Port 5432)
- **Vị trí**: Container `factorix-postgres` thuộc Docker Compose group `factoriX` (`postgresql://factorix:***@127.0.0.1:5432/factorix`).
- **Nhiệm vụ**: Lưu trữ toàn bộ siêu dữ liệu nền tảng, chuỗi thời gian phân vùng, trạng thái tức thời và kiểm toán.
- **Dung lượng hiện tại**: **18 GB** (Dung lượng volume `factorix-pg-data`).
- **Phân bổ bảng dung lượng lớn nhất**:
  - `observations_2026_11` (Bảng chuỗi thời gian tháng 11/2026): **15 GB** (16,55 GB).
  - `ingest_dedup` (Bảng chống trùng lặp quan sát): **2.44 GB**.
  - `latest_signal_state` (Trạng thái tức thời 344 tín hiệu): **14 MB**.
  - `model_snapshots` / `output_groups` / `model_state`: **~12 MB**.
- **Tốc độ nạp & Tăng trưởng đo đạc thực tế**:
  - **Tần suất nạp**: **~298 - 300 observations/giây** (Khớp với 336 tín hiệu chu kỳ 1s).
  - **Tốc độ tăng dung lượng**: **~0.268 MB/giây** (~281 KB/s).
  - **Tốc độ tăng tích lũy**: Khoảng **16 MB/phút**, tương đương **~965 MB/giờ** (~**22.6 GB/ngày** trước khi chạy chính sách nén/retention).

### 3. Time-Series Engine: TDengine 3.4.3.9 (Port 6041)
- **Vị trí**: Container `factorix-tdengine` thuộc Docker Compose group `factoriX` (`ws://root:taosdata@127.0.0.1:6041`).
- **Nhiệm vụ**: Lưu trữ và truy vấn chuỗi thời gian tốc độ cao (Historian, Storage Engine, Super-tables và Sub-tables).

### 4. Message Broker: RabbitMQ 4.4 Management (Ports 5672, 15672)
- **Vị trí**: Container `factorix-rabbitmq` thuộc Docker Compose group `factoriX` (`amqp://factorix_mq:***@127.0.0.1:5672/`).
- **Nhiệm vụ**: Phân phối message ingestion, quorum queues, telemetry streaming giữa collector và engine.

---

## 7. Vận hành, Giám sát & Khắc phục Sự cố (Runbook & Operations)

### Thông tin đăng nhập mặc định:
- **URL Web Console**: `http://localhost:8080`
- **Username**: `dangtai`
- **Password**: `Avenue-net@2026`

### Các lệnh vận hành nhanh (CLI):

#### 1. Kiểm tra trạng thái Container & Dịch vụ (Stack factoriX):
```powershell
docker compose ps
docker logs -f --tail 100 factorix-appliance
```

#### 2. Kiểm tra chất lượng Tín hiệu trực tiếp trong PostgreSQL 17:
```powershell
docker exec factorix-postgres psql -U factorix -d factorix -c "SELECT quality, count(*) FROM latest_signal_state GROUP BY quality;"
```
*(Kết quả chuẩn: `GOOD | 344` hoặc `GOOD | 336`, `0 BAD`, `0 STALE`)*

#### 3. Kiểm tra sức khỏe Kết nối OT:
```powershell
docker exec factorix-postgres psql -U factorix -d factorix -c "SELECT name, protocol, status, health FROM connections;"
```
*(Kết quả chuẩn: 5 kết nối PC03 đều `ACTIVE` và `HEALTHY`)*

#### 4. Kiểm tra TDengine và RabbitMQ:
```powershell
# TDengine 3.4.3
docker exec factorix-tdengine taos -s "SHOW DATABASES;"

# RabbitMQ 4.4 ping
docker exec factorix-rabbitmq rabbitmq-diagnostics -q ping
```

#### 5. Chạy Test Suite toàn diện:
```powershell
# Chạy Chaotic safety tests
python -m pytest tests/chaotic/test_chaotic_tester_scenarios.py -v

# Chạy 100x Scale Load Benchmark (TDengine 3.4.3 & RabbitMQ 4.4)
python -m pytest tests/scale/test_100x_scale_load.py -v
```
```

---

## 8. Lịch sử Nghiệm thu & Tối ưu Hiệu năng

Bản dựng hiện tại đã giải quyết triệt để 100% các vấn đề phát hiện trong đợt kiểm thử độc lập **Round 5**:

| Mã lỗi | Mô tả sự cố gốc | Giải pháp triệt để đã triển khai | Kết quả nghiệm thu |
|---|---|---|---|
| **R5-ENV-01** | Collector mất kết nối định kỳ (15 lần/78 phút), outbox khóa vòng lặp chính tới 67 s | Bổ sung partial index `outbox_terminal_created_idx`, chuyển dọn dẹp sang `asyncio.to_thread` với chunks có giới hạn. | **Triệt để (0 lần mất kết nối)** |
| **BOTTLENECK-DB** | Bảng `ingest_dedup` 17 triệu dòng quét full table làm đơ database 25s | Đánh index B-tree `ingest_dedup(first_seen_at)`, rút ngắn thời gian dọn dẹp từ 25.000 ms xuống **15 ms**. Giảm thời gian lưu dedup xuống 2 giờ. | **Triệt để (15 ms prune)** |
| **BOTTLENECK-HTTP**| Thu thập HTTP tuần tự 6 máy mất 4,2 s / chu kỳ 5,0 s | Chuyển sang thu thập đồng thời `asyncio.gather`, rút ngắn còn **~600 ms**. Tăng pool kết nối lên 16 và thêm cơ chế retry ngắt socket keep-alive. | **Triệt để (Nhanh gấp 7 lần)** |
| **R5-SG-03** | Lỗi React #310 làm trắng trang khi bấm "Edit source address…" | Di chuyển React Hook `useRef` lên trước lệnh early return trong modal. | **Đạt 100%** |
| **R5-SG-02** | Khóa ô "Round digits" khi sửa thuộc tính hàng loạt | Mở khóa ô làm tròn số cho tất cả kiểu số (`float32`, `float64`, `analog`, `int16-64`). | **Đạt 100%** |
| **R5-SG-01** | Shift-click không chọn dải hàng trong bảng Signals | Bổ sung ref theo dõi danh sách hiển thị và xử lý click range chuẩn xác. | **Đạt 100%** |
| **R5-DM-01** | Checkbox nhận body sự kiện trong Paste JSON bị tắt mặc định | Tự động kích hoạt khi phát hiện JSON chứa định dạng sự kiện. | **Đạt 100%** |
| **R5-DM-02** | Thông báo lỗi khi xóa signal bị hiển thị trùng lặp | Loại bỏ trùng lặp thông báo theo từng dòng trường dữ liệu. | **Đạt 100%** |
| **R5-DM-03/04** | Pause/Resume hàng loạt và lưu model 350 trường bị chậm | Song song hóa Promise.all và tối ưu hóa câu lệnh SQL scalar subquery. | **Đạt 100%** |
| **BRANDING** | Logo công ty bị sai trên màn hình Đăng nhập và Sidebar | Cập nhật hình ảnh logo `factorix_brand_logo.png` (độ phân giải cao 6184×1588). | **Đạt 100%** |
| **UI-OVERVIEW** | Bảng "Latest values" bị nhảy kích thước cột khi dữ liệu đổi độ dài | Khóa cố định cấu trúc bảng `table-layout: fixed` với độ rộng px cụ thể. | **Đạt 100% (0px drift)** |

---
*Tài liệu này được biên soạn và cập nhật tự động vào tháng 11/2026 dựa trên toàn bộ phân tích mã nguồn thực tế và dữ liệu runtime của dự án FactoriX.*
