import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';

async function run() {
  const worker = await createWorker('eng');
  const cropDir = 'artifacts/crops';
  const files = fs.readdirSync(cropDir).filter(f => f.endsWith('_header.png')).sort();
  
  console.log(`Running OCR on ${files.length} cropped headers...`);
  const results = [];

  for (const file of files) {
    const filePath = path.join(cropDir, file);
    try {
      const { data: { text } } = await worker.recognize(filePath);
      const cleanLines = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 2);
      
      const title = cleanLines[0] || 'Unknown';
      const subtitle = cleanLines.slice(1).join(' ');
      
      const id = file.replace('_header.png', '');
      results.push({ id, file, title, subtitle, raw: cleanLines.join(' // ') });
      console.log(`[${id}] ${title}`);
    } catch (err) {
      console.error(`Error on ${file}:`, err);
    }
  }

  await worker.terminate();
  fs.writeFileSync('scripts/ocr_headers_summary.json', JSON.stringify(results, null, 2));
  console.log('Saved to scripts/ocr_headers_summary.json');
}

run();
