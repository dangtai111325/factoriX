import fs from 'fs';
import { createWorker } from 'tesseract.js';

async function main() {
  const worker = await createWorker('eng');
  const navTargets = ['01', '10', '20', '30', '40'];

  for (const id of navTargets) {
    const file = `artifacts/crops/${id}_nav.png`;
    if (!fs.existsSync(file)) continue;
    const { data: { text } } = await worker.recognize(file);
    console.log(`\n=== NAV [${id}] ===`);
    console.log(text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 25).join('\n'));
  }

  await worker.terminate();
}

main().catch(console.error);
