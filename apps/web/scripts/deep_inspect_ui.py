import os, json

def inspect():
    with open('scripts/ocr_headers_summary.json', 'r', encoding='utf-8') as f:
        headers = json.load(f)
        
    print(f"Loaded {len(headers)} headers.")
    for h in headers:
        raw = h.get('raw', '')
        title = h.get('title', '')
        sub = h.get('subtitle', '')
        print(f"[{h['id']}] {title} || {sub}")

if __name__ == '__main__':
    inspect()
