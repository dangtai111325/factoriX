import os
import subprocess
import time

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE_URL = "http://localhost:3000"
OUTPUT_DIR = r"C:\Users\Ave-T14-001\Desktop\FactoriX\iiot-frontend\artifacts\visual_qa_v2"

SCREENSHOTS = [
    {
        "name": "08__signals_with_sparklines.png",
        "url": f"{BASE_URL}/signals",
        "title": "Signals Catalog with In-Table Micro Sparklines and Plant Selector"
    },
    {
        "name": "10__live_monitor_matrix.png",
        "url": f"{BASE_URL}/live/monitor",
        "title": "Live Operations Monitor with Live Waveform & Telemetry KPIs"
    }
]

def main():
    print("Capturing updated screens...")
    for s in SCREENSHOTS:
        out_path = os.path.join(OUTPUT_DIR, s["name"])
        cmd = [
            CHROME_PATH,
            "--headless=new",
            "--window-size=1672,941",
            "--hide-scrollbars",
            "--virtual-time-budget=2000",
            f"--screenshot={out_path}",
            s["url"]
        ]
        print(f"  -> {s['title']} -> {s['name']}")
        subprocess.run(cmd, check=True)
        time.sleep(0.5)
    print("Screenshots captured successfully!")

if __name__ == "__main__":
    main()
