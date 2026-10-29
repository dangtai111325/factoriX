import os
import json
from PIL import Image

def main():
    img_dir = r"C:\Users\Ave-T14-001\Downloads\images"
    files = sorted([f for f in os.listdir(img_dir) if f.endswith('.png')])
    
    with open('scripts/ocr_headers_summary.json', 'r', encoding='utf-8') as f:
        headers = json.load(f)
        
    print(f"Total images found: {len(files)}, OCR headers: {len(headers)}")
    for h in headers:
        title = h.get('title', '').strip()
        sub = h.get('subtitle', '').strip()
        print(f"[{h['id']}] {title} --- {sub[:50]}")

if __name__ == '__main__':
    main()
