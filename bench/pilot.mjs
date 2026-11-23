// 사람 파일럿: 저자 1인이 10~15개 항목을 인증하며 시간을 기록한다.
//   node bench/pilot.mjs [--n 12] [--design ab|a] [--seed 1] [--port 5300]
//   → 브라우저로 http://127.0.0.1:5300/pilot.html 을 열고 위에서부터 순서대로 처리. 끝나면 Ctrl+C.
//   → 종료 시 bench/results/raw/pilot-<시각>/sessions.jsonl 생성, 이어서: node bench/analyze.mjs pilot-<시각>
// design=ab: 항목마다 A(게이트)/B(승인만)를 번갈아 배정(피험자 내 비교, 같은 항목은 한 번만 봄)
// design=a : 전부 A(게이트) — 소요 시간·사유 기록만 볼 때
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/server.js';

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const N = Number(a.n ?? 12), DESIGN = a.design ?? 'ab', SEED = Number(a.seed ?? 1), PORT = Number(a.port ?? 5300);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tasks.json'), 'utf8')).items;
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'truth.json'), 'utf8'));
let s = SEED;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuf = (x) => { for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
// 층화 추출: 오류 ≈ 45%, 쟁점 1개, 나머지 정상. 14%(워킹페이퍼)/15%(출판본) 판본 사례(skill_compression)는 항상 포함
const by = (l) => shuf(tasks.filter((t) => truth[t.id].label === l).map((t) => t.id));
const must = tasks.find((t) => truth[t.id].source_origin === 'ontology:skill_compression').id;
const nErr = Math.round(N * 0.45), nCt = 1;
const pick = [must, ...by('error').filter((x) => x !== must).slice(0, nErr - 1), ...by('contested').slice(0, nCt), ...by('correct').slice(0, N - nErr - nCt)];
const order = shuf(pick);
const plan = order.map((id, i) => ({ id, cond: DESIGN === 'a' ? 'A' : i % 2 === 0 ? 'A' : 'B' }));
const tag = `pilot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const dir = path.join(ROOT, 'bench', 'results', 'raw', tag);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ tag, n: N, design: DESIGN, seed: SEED, plan }, null, 1));
const { server } = createApp({ bench: true, itemsFile: path.join(ROOT, 'bench', 'tasks.json'), dataDir: dir, logFile: path.join(dir, 'server-log.jsonl'), pilotPlan: plan.map((p) => ({ ...p, meta: `${tag}|human|normal|${p.cond}|${p.id}` })) });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`파일럿 ${tag}: ${plan.length}개 항목 (design=${DESIGN})`);
  console.log(`브라우저에서 http://127.0.0.1:${PORT}/pilot.html 을 열고 위에서부터 처리하세요. 끝나면 Ctrl+C.`);
});
function finish() {
  const logf = path.join(dir, 'server-log.jsonl');
  const logs = fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const recs = logs.map((r) => {
    const [, model, variant, cond, item] = r.meta.split('|');
    return { model, variant, cond, item, cond_pos: 0, meta: r.meta, model_id: `human:${r.actor.name}`, decision: r.decision, rounds: 1, steps: r.events.length + 1, llm_ms: 0, wall_ms: r.duration_ms, llm_errors: 0 };
  });
  fs.writeFileSync(path.join(dir, 'sessions.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
  console.log(`\n${recs.length}건 기록 → ${dir}/sessions.jsonl\n분석: node bench/analyze.mjs ${tag}`);
  process.exit(0);
}
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
