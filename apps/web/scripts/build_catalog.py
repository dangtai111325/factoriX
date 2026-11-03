import glob
import os
from PIL import Image

files = sorted(glob.glob(r'C:\Users\Ave-T14-001\Downloads\images\*.png'))
print(f"Total images found: {len(files)}")

# Also let's crop the header area (x=280..900, y=70..150) where titles are located
crop_dir = r"artifacts\header_crops"
os.makedirs(crop_dir, exist_ok=True)

html = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Catalog of 49 Candidate Reference Images</title>
<style>
  body { font-family: Inter, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; margin: 0; }
  h1 { font-size: 24px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(650px, 1fr)); gap: 24px; }
  .card { background: #1e293b; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
  .card h3 { margin: 0 0 10px; font-size: 15px; color: #38bdf8; word-break: break-all; }
  .card img { width: 100%; border-radius: 8px; border: 1px solid #475569; display: block; }
</style>
</head>
<body>
<h1>Catalog of 49 Candidate Reference Images (Downloads/images)</h1>
<div class="grid">
"""

for i, f in enumerate(files):
    name = os.path.basename(f)
    abs_path = os.path.abspath(f).replace("\\", "/")
    html += f"""
  <div class="card" id="img-{i+1}">
    <h3>#{i+1}: {name}</h3>
    <img src="file:///{abs_path}" loading="lazy" />
  </div>
"""

html += """
</div>
</body>
</html>
"""

with open("scripts/catalog_49_images.html", "w", encoding="utf-8") as out:
    out.write(html)

print("Generated scripts/catalog_49_images.html")
