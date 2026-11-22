// 정제 데이터 v2-exp3-clean = claude 층(v2-exp3) + codex 단일 회차 재현(v2-exp3-codex-rep2)
// 사용: node bench/v2/merge-clean.mjs && node bench/v2/analyze-v2.mjs v2-exp3-clean
import fs from 'node:fs';
import path from 'node:path';
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'results', 'raw');
const jl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const out = path.join(R, 'v2-exp3-clean');
fs.mkdirSync(out, { recursive: true });
const pick = (tag, model) => ({
  s: jl(path.join(R, tag, 'sessions.jsonl')).filter((x) => x.model === model),
  l: jl(path.join(R, tag, 'server-log.jsonl')).filter((x) => x.meta.split('|')[1] === model),
});
const a = pick('v2-exp3', 'claude-haiku'), b = pick('v2-exp3-codex-rep2', 'codex');
const S = [...a.s, ...b.s], L = [...a.l, ...b.l];
fs.writeFileSync(path.join(out, 'sessions.jsonl'), S.map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'server-log.jsonl'), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'SOURCES.md'), `claude-haiku: v2-exp3 (${a.s.length}세션, 1개는 재실행·결정 동일)\ncodex: v2-exp3-codex-rep2 (${b.s.length}세션, 단일 회차)\n`);
console.log(`clean: claude ${a.s.length} + codex ${b.s.length} sessions, llm_errors ${S.filter((x) => x.llm_errors > 0).length}`);
