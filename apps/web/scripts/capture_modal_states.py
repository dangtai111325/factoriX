import os
import subprocess
import time

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE_URL = "http://localhost:3000"
OUTPUT_DIR = r"C:\Users\Ave-T14-001\Desktop\FactoriX\iiot-frontend\artifacts\visual_qa_v2"

MODALS = [
    {
        "name": "modal_add_resource.png",
        "url": f"{BASE_URL}/factory/structure?modal=add",
        "title": "Add Factory Resource Modal (Img 02, 21)"
    },
    {
        "name": "modal_move_resource.png",
        "url": f"{BASE_URL}/factory/structure?modal=move",
        "title": "Move Resource Hierarchy Modal (Img 21)"
    },
    {
        "name": "modal_add_data_wizard.png",
        "url": f"{BASE_URL}/acquisition/connections?modal=wizard",
        "title": "5-Step Universal Add Data Wizard (Img 06, 16, 17)"
    },
    {
        "name": "modal_connection_test_ping.png",
        "url": f"{BASE_URL}/acquisition/connections?modal=test",
        "title": "Connection Handshake & Latency Test Modal (Img 24)"
    },
]

def main():
    print("Capturing Interactive Modal States at 1672x941...")
    for m in MODALS:
        out_path = os.path.join(OUTPUT_DIR, m["name"])
        cmd = [
            CHROME_PATH,
            "--headless=new",
            "--window-size=1672,941",
            "--hide-scrollbars",
            "--virtual-time-budget=2000",
            f"--screenshot={out_path}",
            m["url"]
        ]
        print(f"  -> {m['title']} -> {m['name']}")
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)

    print("Modal captures complete!")

if __name__ == "__main__":
    main()
