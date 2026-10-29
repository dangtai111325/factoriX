import glob
import os
import hashlib
from PIL import Image, ImageChops

v7_files = sorted(glob.glob(r"FACTORIX_IIOT_COMPLETE_DESIGN_HANDOFF_V7\01_ORIGINAL_REFERENCES\*.png"))
dl_files = sorted(glob.glob(r"C:\Users\Ave-T14-001\Downloads\images\*.png"))

print(f"V7 Reference Images: {len(v7_files)}")
print(f"Downloads Images: {len(dl_files)}")

# Compute md5 of all V7 files
v7_hashes = {}
for vf in v7_files:
    with open(vf, "rb") as f:
        h = hashlib.md5(f.read()).hexdigest()
        v7_hashes[h] = os.path.basename(vf)

exact_matches = []
new_images = []

for df in dl_files:
    with open(df, "rb") as f:
        h = hashlib.md5(f.read()).hexdigest()
    if h in v7_hashes:
        exact_matches.append((os.path.basename(df), v7_hashes[h]))
    else:
        new_images.append(df)

print(f"\nExact matches with V7 handoff kit: {len(exact_matches)}")
for d_name, v_name in exact_matches:
    print(f"  {d_name} == {v_name}")

print(f"\nImages in Downloads that are DIFFERENT / NEW: {len(new_images)}")
for idx, nf in enumerate(new_images):
    print(f"  [{idx+1}] {os.path.basename(nf)}")
