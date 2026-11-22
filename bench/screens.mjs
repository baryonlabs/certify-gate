// 벤치 조건 A/B/C 화면 스크린샷(문서용): node bench/screens.mjs [항목ID]
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from '@playwright/test';
import { createApp } from '../src/server.js';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'truth.json'), 'utf8'));
const id = process.argv[2] ?? Object.entries(truth).find(([, t]) => t.source_origin === 'ontology:skill_compression')[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shots-'));
const { server } = createApp({ bench: true, itemsFile: path.join(ROOT, 'bench', 'tasks.json'), dataDir: tmp });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
for (const [c, url] of [['A', `/certify.html?id=${id}`], ['B', `/review.html?id=${id}&condition=B`], ['C', `/review.html?id=${id}&condition=C`]]) {
  await p.goto(base + url);
  await p.locator('body[data-ready="1"]').waitFor();
  await p.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', `cond-${c}-${id}.png`), fullPage: true });
}
await b.close(); server.close();
console.log('saved docs/screenshots/cond-{A,B,C}-' + id + '.png');
