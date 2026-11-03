import glob
import os
from PIL import Image

files = sorted(glob.glob(r"C:\Users\Ave-T14-001\Downloads\images\*.png"))
os.makedirs(r"artifacts\crops", exist_ok=True)

print(f"Cropping headers for {len(files)} images...")

for i, f in enumerate(files):
    img = Image.open(f)
    # Header area: x=270..1400, y=60..170
    header = img.crop((270, 60, 1400, 170))
    header.save(f"artifacts/crops/{i+1:02d}_header.png")
    
    # Nav/sidebar area: x=0..280, y=60..600
    nav = img.crop((0, 60, 280, 600))
    nav.save(f"artifacts/crops/{i+1:02d}_nav.png")

print("Cropping complete!")
