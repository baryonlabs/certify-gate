// 난이도 파일럿(사전 등록 규칙): 평가에 쓰지 않는 모델(claude-sonnet)이 화면 없이 초안+원문 전문을 보고 2회 판정.
// 2회 모두 정답과 다르면 '바닥(라벨 의심)' → bench/v2/pilot-exclude.json 에 문서 ID 추가 → build-hard 재생성.
// 사용: node bench/v2/pilot-difficulty.mjs [--round 1]
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, parseJson } from '../llm.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const round = process.argv.includes('--round') ? process.argv[process.argv.indexOf('--round') + 1] : '1';
const tasks = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8')).items;
const truth = JSON.parse(fs.readFileSync(path.join(HERE, 'truth.json'), 'utf8'));
const SYS = 'You verify AI-written claims against primary sources. Output a single JSON object only.';
const prompt = (it) => `Draft claims (written by an AI agent):\n${it.sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nPrimary source(s):\n${it.sources.map((s, i) => `[Source ${i + 1}${s.edition ? ` — edition: ${s.edition}` : ''}] ${s.text}`).join('\n\n')}\n\nRules: The draft is CORRECT only if every claim matches the source in meaning, numbers, units, years, scope/population and causal strength. Different wording with the same meaning is CORRECT. If several editions exist, the final published edition is authoritative.\nReturn {"verdict":"correct"|"error","reason":"<short>"}`;
const out = [];
let i = 0;
async function worker() {
  while (i < tasks.length) {
    const it = tasks[i++];
    const v = [];
    for (let k = 0; k < 2; k++) {
      const r = await MODELS['claude-sonnet'].call(SYS, prompt(it));
      v.push(parseJson(r.text)?.verdict ?? 'parse_error');
    }
    const truthLabel = truth[it.id].label;
    const correct = v.filter((x) => x === truthLabel).length;
    out.push({ id: it.id, origin: truth[it.id].origin, label: truthLabel, error_type: truth[it.id].error_type, verdicts: v, n_correct: correct });
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
out.sort((a, b) => a.id.localeCompare(b.id));
const floor = out.filter((o) => o.n_correct === 0);
fs.writeFileSync(path.join(HERE, `pilot-round${round}.json`), JSON.stringify({ model: 'claude-sonnet', samples: 2, results: out, floor: floor.map((f) => f.id) }, null, 1));
const exf = path.join(HERE, 'pilot-exclude.json');
const ex = fs.existsSync(exf) ? JSON.parse(fs.readFileSync(exf, 'utf8')) : [];
for (const f of floor) { const m = f.origin.match(/scifact-doc:(\d+)/); if (m && !ex.includes(m[1])) ex.push(m[1]); }
fs.writeFileSync(exf, JSON.stringify(ex, null, 1));
const acc = out.reduce((a, o) => a + o.n_correct, 0) / (2 * out.length);
console.log(`pilot round ${round}: full-read accuracy ${(100 * acc).toFixed(1)}%, floor items ${floor.length}:`, floor.map((f) => `${f.id}(${f.label}/${f.error_type ?? '-'})`).join(' '));
