import os
import subprocess
import time

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE_URL = "http://localhost:3000"
OUTPUT_DIR = r"C:\Users\Ave-T14-001\Desktop\FactoriX\iiot-frontend\artifacts\visual_qa_v2"
os.makedirs(OUTPUT_DIR, exist_ok=True)

ROUTES = [
    ("01__overview.png", f"{BASE_URL}/", "01 Operations Overview"),
    ("02__factory_structure.png", f"{BASE_URL}/factory/structure", "02 Factory Structure"),
    ("03__factory_layout.png", f"{BASE_URL}/factory/layout", "03 Factory Layout"),
    ("04__factory_graph.png", f"{BASE_URL}/factory/graph", "04 Knowledge Graph"),
    ("05__acquisition_connections.png", f"{BASE_URL}/acquisition/connections", "05 Industrial Connections"),
    ("06__acquisition_add-data.png", f"{BASE_URL}/acquisition/add-data", "06 Add Data Wizard"),
    ("07__acquisition_studio_opcua.png", f"{BASE_URL}/acquisition/studio/opcua", "07 OPC UA Studio"),
    ("08__signals.png", f"{BASE_URL}/signals", "08 Signals Catalog"),
    ("09__signals_calculated.png", f"{BASE_URL}/signals/calculated", "09 Calculated Signals"),
    ("10__live_monitor.png", f"{BASE_URL}/live/monitor", "10 Live Operations Monitor"),
    ("11__live_diagnostics.png", f"{BASE_URL}/live/diagnostics", "11 Diagnostics Center"),
    ("12__live_activity.png", f"{BASE_URL}/live/activity", "12 Activity Log"),
    ("13__signals_output-groups.png", f"{BASE_URL}/signals/output-groups", "13 Output Groups"),
    ("14__acquisition_studio_mqtt.png", f"{BASE_URL}/acquisition/studio/mqtt", "14 MQTT Mapping Studio"),
    ("15__acquisition_studio_http.png", f"{BASE_URL}/acquisition/studio/http", "15 HTTP REST Studio"),
]

MODALS = [
    ("modal_add_resource.png", f"{BASE_URL}/factory/structure?modal=add", "Modal - Add Factory Resource"),
    ("modal_move_resource.png", f"{BASE_URL}/factory/structure?modal=move", "Modal - Move Resource Hierarchy"),
    ("modal_add_data_wizard.png", f"{BASE_URL}/acquisition/connections?modal=wizard", "Modal - Add Data Wizard"),
    ("modal_connection_test_ping.png", f"{BASE_URL}/acquisition/connections?modal=test", "Modal - Connection Diagnostics & Test"),
]

def capture(name, url, title, width=1672, height=941):
    out_path = os.path.join(OUTPUT_DIR, name)
    cmd = [
        CHROME_PATH,
        "--headless=new",
        f"--window-size={width},{height}",
        "--hide-scrollbars",
        "--virtual-time-budget=2500",
        f"--screenshot={out_path}",
        url
    ]
    print(f"Capturing: {title} ({width}x{height}) -> {name}")
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.3)

def main():
    print("=== Capturing 15 Full-Resolution Desktop Screens (1672x941) ===")
    for name, url, title in ROUTES:
        capture(name, url, title, 1672, 941)

    print("\n=== Capturing Interactive Modal Dialogs ===")
    for name, url, title in MODALS:
        capture(name, url, title, 1672, 941)

    print("\n=== Capturing Tablet / Compact Desktop Viewport (1366x768) ===")
    capture("01__overview_1366.png", f"{BASE_URL}/", "01 Overview (1366x768)", 1366, 768)
    capture("08__signals_1366.png", f"{BASE_URL}/signals", "08 Signals Catalog (1366x768)", 1366, 768)
    capture("10__live_monitor_1366.png", f"{BASE_URL}/live/monitor", "10 Live Monitor (1366x768)", 1366, 768)

    print("\nAll visual QA screenshots captured successfully!")

if __name__ == "__main__":
    main()
