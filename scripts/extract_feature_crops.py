import os, json
import subprocess
from PIL import Image

def analyze_features():
    img_dir = r"C:\Users\Ave-T14-001\Downloads\images"
    files = sorted([f for f in os.listdir(img_dir) if f.endswith('.png')])
    
    crops_dir = "artifacts/crops_features"
    os.makedirs(crops_dir, exist_ok=True)
    
    # We will crop the center/content area: (x=240 to 1672, y=70 to 941)
    # Also if there's a modal, it's typically centered at x=400..1300, y=100..850
    targets = [
        ("02", "add_resource_modal", 350, 100, 1350, 850),
        ("06", "add_data_wizard", 300, 100, 1400, 850),
        ("07", "mqtt_mapping_flow", 260, 80, 1660, 920),
        ("09", "create_calculated_rule", 300, 100, 1400, 850),
        ("16", "modbus_wizard", 300, 100, 1400, 850),
        ("17", "opcua_wizard", 300, 100, 1400, 850),
        ("18", "jsonpath_mapping", 260, 80, 1660, 920),
        ("21", "add_child_move_toolbar", 260, 80, 1660, 400),
        ("24", "import_template_test", 260, 80, 1660, 920),
        ("27", "bulk_edit_signals", 260, 80, 1660, 920),
        ("29", "live_monitor_controls", 260, 80, 1660, 920),
        ("38", "live_monitor_v2", 260, 80, 1660, 920),
        ("39", "diagnostics_detail", 260, 80, 1660, 920),
        ("48", "live_monitor_v3", 260, 80, 1660, 920),
        ("49", "diagnostics_troubleshoot", 260, 80, 1660, 920),
    ]
    
    crops_manifest = []
    for idx_str, name, x1, y1, x2, y2 in targets:
        idx = int(idx_str) - 1
        fn = files[idx]
        im = Image.open(os.path.join(img_dir, fn))
        crop = im.crop((x1, y1, x2, y2))
        out_fn = f"{idx_str}_{name}.png"
        out_path = os.path.join(crops_dir, out_fn)
        crop.save(out_path)
        crops_manifest.append({"id": idx_str, "name": name, "file": out_fn, "path": out_path})
        
    print(f"Generated {len(crops_manifest)} feature crops in {crops_dir}")
    with open("artifacts/crops_features/manifest.json", "w") as f:
        json.dump(crops_manifest, f, indent=2)

if __name__ == '__main__':
    analyze_features()
