import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';

async function main() {
  const manifest = JSON.parse(fs.readFileSync('artifacts/crops_features/manifest.json', 'utf8'));
  const worker = await createWorker('eng');

  console.log(`Analyzing ${manifest.length} feature crops...`);
  const results = [];

  for (const item of manifest) {
    console.log(`Processing [${item.id}] ${item.name}...`);
    const { data: { text } } = await worker.recognize(item.path);
    const cleaned = text.split('\n').map(l => l.trim()).filter(Boolean);
    results.push({
      id: item.id,
      name: item.name,
      file: item.file,
      summary: cleaned.slice(0, 20),
      full_text: cleaned.join(' \n ')
    });
  }

  await worker.terminate();
  fs.writeFileSync('artifacts/crops_features/ocr_features.json', JSON.stringify(results, null, 2));
  console.log('Saved to artifacts/crops_features/ocr_features.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
