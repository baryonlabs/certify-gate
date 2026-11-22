// 합성 퍼소나 셀프 설문 시뮬레이션 (docs/PREREG_persona.md)
// 사용: node bench/persona/run-sim.mjs [--n 30] [--conc 6] [--tag main]
// 퍼소나 단위로 전 단계(판단 생성→배정→질문→응답→채점)를 끝내고 저장한다. 중단 후 다시 실행하면 이어서 한다.
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, parseJson } from '../llm.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const N = Number(arg('n', 30)), CONC = Number(arg('conc', 6)), TAG = arg('tag', 'main');
const OUT = path.join(HERE, 'results', 'raw', TAG);
fs.mkdirSync(OUT, { recursive: true });
const personas = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'personas.json'), 'utf8')).personas.slice(0, N);
const ARMS = [
  { arm: 1, P: 'claude-haiku', Q: 'gpt-luna' },
  { arm: 2, P: 'gpt-luna', Q: 'claude-haiku' },
];
const JUDGES = ['claude-sonnet', 'gemini-argon'];
const VARIANTS = ['normal', 'rushed'];
let ABORT = null;

function rng(seedStr) {
  let s = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2 ** 31, 7);
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
function shuffle(a, r) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function ask(model, sys, user, check, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (ABORT) throw new Error(`abort: ${ABORT}`);
    const r = await MODELS[model].call(sys, user);
    if (r.error && /usage limit|hit your usage|rate limit|quota|429/i.test(r.error)) { ABORT = `${model} usage limit`; throw new Error(ABORT); }
    const j = parseJson(r.text);
    if (j && (!check || check(j))) return { json: j, model_id: r.model_id, ms: r.ms };
    if (attempt === 2) throw new Error(`${label}: 해석 실패 (${model}) ${String(r.error ?? r.text).slice(0, 200)}`);
  }
}

const profile = (p) => `- 성별·나이: ${p.sex}, ${p.age}세\n- 지역: ${p.district}\n- 직업: ${p.occupation}\n- 학력: ${p.education_level}\n- 소개: ${p.persona}\n- 직업 생활: ${p.professional_persona}\n- 숙련: ${p.skills_and_expertise}`;

// 1. 판단 생성 (P)
const GEN_SYS = '너는 사람의 업무 행동과 그 이면의 판단 기준을 사실적으로 구성하는 연구 보조자다. JSON 객체 하나만 출력한다.';
const genPrompt = (p) => `다음 사람의 프로필을 보라.\n${profile(p)}\n
이 사람이 최근 업무에서 **반복적으로** 내리는 판단 12개를 만들어라. 각 판단은 두 부분이다.
- behavior: 겉으로 관찰되는 행동만 쓴 한 문장(60자 이내). 이유나 기준은 쓰지 않는다. 예: "견적서를 보낼 때 납기를 항상 하루 늦춰 적는다"
- hidden_reason: 이 사람이 실제로 그렇게 하는 숨은 이유. 매뉴얼에 없고 말로 정리해 본 적 없는, 이 사람만의 구체적 판단 기준(조건·수치·경험에서 나온 규칙 포함, 1~2문장, 120자 이내). 누구나 짐작하는 일반론은 피한다.
12개 판단은 서로 다른 상황이어야 한다.
출력: {"items":[{"behavior":"...","hidden_reason":"..."}, ...12개]}`;

// 3. 질문 생성 (Q) — 판단 문장과 직무만 본다
const Q_SYS = '너는 사람의 행동에서 기존 지식으로 설명되지 않는 부분을 찾아, 그 이유를 묻는 질문과 예상 답을 만드는 인터뷰 에이전트다. JSON 객체 하나만 출력한다.';
const qPrompt = (occ, items) => `직무: ${occ}\n아래는 이 사람이 실제로 한 업무 행동이다. 각 행동마다
- question: 그 행동의 숨은 판단 기준을 겨냥한 질문 1개(50자 이내)
- options: 가장 가능성이 높은 예상 이유 3개(각 40자 이내, 서로 다른 기준)
를 만들어라.
${items.map((x) => `[${x.id}] ${x.behavior}`).join('\n')}
출력: {"items":[{"id":"...","question":"...","options":["...","...","..."]}]}`;

// 4. 응답 (P, 새 세션)
const RUSHED = '\n[상황] 지금 매우 바쁘다. 이 설문은 귀찮은 업무 중 하나이고 빨리 끝내야 한다. 깊게 생각하지 말고 대충 빠르게 답하라.';
const R_SYS = (p) => `너는 아래 프로필의 사람 본인이다. 그 사람으로서 설문에 답한다. JSON 객체 하나만 출력한다.\n${profile(p)}`;
const memory = (items) => `당신이 평소 이 일들을 하는 실제 이유(당신의 기억, 말로 정리해 본 적은 없다):\n${items.map((x) => `[${x.id}] ${x.behavior} — ${x.hidden_reason}`).join('\n')}`;
const aPrompt = (items, qs, rushed) => `${memory(items)}${rushed ? RUSHED : ''}\n
업무 지식 정리 설문이다. 각 항목에 당신의 행동, AI가 만든 질문, 예상 이유 3개가 있다.
- picks: 당신의 실제 이유와 맞는 예상 이유의 번호(0,1,2, 복수 가능). 맞는 것이 없으면 빈 배열.
- none_correct: 맞는 것이 하나도 없으면 true
- correction: 빠진 조건이나 틀린 점을 고치고 싶으면 적는다(선택, 없으면 빈 문자열)
${qs.map((q) => `[${q.id}] 행동: ${items.find((x) => x.id === q.id).behavior}\n  질문: ${q.question}\n  0) ${q.options[0]}\n  1) ${q.options[1]}\n  2) ${q.options[2]}`).join('\n')}
출력: {"answers":[{"id":"...","picks":[...],"none_correct":false,"correction":""}]}`;
const bPrompt = (items, rushed) => `${memory(items)}${rushed ? RUSHED : ''}\n
업무 지식 정리 설문이다. 아래 각 행동에 대해, 왜 그렇게 하는지 이유를 직접 적어라.
${items.map((x) => `[${x.id}] ${x.behavior}`).join('\n')}
출력: {"answers":[{"id":"...","text":"..."}]}`;

// 5. 채점 (J, 조건 모름)
const J_SYS = '너는 설문 응답 채점자다. 응답 형식이나 길이가 아니라 내용으로만 판단한다. JSON 객체 하나만 출력한다.';
const jPrompt = (recs) => `각 기록에 '행동', '정답 이유'(그 사람의 실제 판단 기준), '응답'이 있다. 응답이 정답 이유를 얼마나 담았는지 채점하라.
- score: 0 = 정답 이유의 핵심 기준이 없음(또는 다른 이유), 1 = 일부만 담음, 2 = 핵심 기준(조건·수치 포함)을 담음
- rules: 응답에 들어 있는 서로 다른 판단 규칙(기준)의 개수(정수, 정답 여부와 무관)
${recs.map((r) => `[${r.rid}] 행동: ${r.behavior}\n  정답 이유: ${r.hidden_reason}\n  응답: ${r.answer_text || '(빈 응답)'}`).join('\n')}
출력: {"items":[{"rid":"...","score":0,"rules":0}]}`;
const hPrompt = (recs) => `각 기록에 '정답 이유'와 AI가 만든 예상 이유 3개가 있다. 각 예상 이유가 정답 이유의 핵심 기준과 같은 내용인지 판정하라(표현이 달라도 기준이 같으면 일치, 일반론으로 일부만 겹치면 불일치).
${recs.map((r) => `[${r.rid}] 행동: ${r.behavior}\n  정답 이유: ${r.hidden_reason}\n  0) ${r.options[0]}\n  1) ${r.options[1]}\n  2) ${r.options[2]}`).join('\n')}
출력: {"items":[{"rid":"...","match":[false,false,false]}]}`;

function answerText(cond, ans, q) {
  if (cond === 'B') return (ans?.text ?? '').trim();
  const picks = (ans?.picks ?? []).filter((k) => [0, 1, 2].includes(k)).map((k) => q.options[k]);
  const parts = [...picks];
  if ((ans?.correction ?? '').trim()) parts.push(ans.correction.trim());
  return parts.join('. ');
}

async function runPersonaArm(p, A) {
  const file = path.join(OUT, `${p.pid}-arm${A.arm}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const t0 = Date.now();
  // 1
  const g = await ask(A.P, GEN_SYS, genPrompt(p), (j) => Array.isArray(j.items) && j.items.length >= 12 && j.items.every((x) => x.behavior && x.hidden_reason), `${p.pid} gen`);
  const items = g.json.items.slice(0, 12).map((x, k) => ({ id: `${p.pid}a${A.arm}-${String(k + 1).padStart(2, '0')}`, behavior: String(x.behavior), hidden_reason: String(x.hidden_reason) }));
  // 2
  const r = rng(`${p.pid}-arm${A.arm}`);
  const ids = shuffle(items.map((x) => x.id), r);
  const cond = Object.fromEntries(ids.map((id, k) => [id, k < 6 ? 'A' : 'B']));
  const Aitems = items.filter((x) => cond[x.id] === 'A'), Bitems = items.filter((x) => cond[x.id] === 'B');
  // 3 (Q는 behavior와 직무만 받는다)
  const q = await ask(A.Q, Q_SYS, qPrompt(p.occupation, Aitems.map(({ id, behavior }) => ({ id, behavior }))), (j) => Array.isArray(j.items) && Aitems.every((x) => j.items.find((y) => y.id === x.id && Array.isArray(y.options) && y.options.length >= 3)), `${p.pid} Q`);
  const qs = Aitems.map((x) => { const y = q.json.items.find((z) => z.id === x.id); return { id: x.id, question: String(y.question ?? ''), options: y.options.slice(0, 3).map(String) }; });
  // 4
  const resp = {};
  await Promise.all(VARIANTS.flatMap((v) => [
    ask(A.P, R_SYS(p), aPrompt(Aitems, qs, v === 'rushed'), (j) => Array.isArray(j.answers) && Aitems.every((x) => j.answers.find((y) => y.id === x.id)), `${p.pid} respA ${v}`).then((x) => (resp[`${v}|A`] = x.json.answers)),
    ask(A.P, R_SYS(p), bPrompt(Bitems, v === 'rushed'), (j) => Array.isArray(j.answers) && Bitems.every((x) => j.answers.find((y) => y.id === x.id)), `${p.pid} respB ${v}`).then((x) => (resp[`${v}|B`] = x.json.answers)),
  ]));
  // 5 기록 구성
  const recs = [];
  for (const v of VARIANTS) for (const it of items) {
    const c = cond[it.id];
    const ans = resp[`${v}|${c}`].find((y) => y.id === it.id);
    const qq = qs.find((z) => z.id === it.id);
    recs.push({
      rid: `${it.id}-${v}`, item: it.id, variant: v, cond: c, behavior: it.behavior, hidden_reason: it.hidden_reason,
      answer: ans, question: qq ?? null, answer_text: answerText(c, ans, qq),
      typed_chars: c === 'B' ? (ans?.text ?? '').length : (ans?.correction ?? '').length,
    });
  }
  const jr = rng(`${p.pid}-arm${A.arm}-judge`);
  const blind = shuffle(recs, jr);
  const hitRecs = qs.map((x) => ({ rid: x.id, behavior: items.find((i) => i.id === x.id).behavior, hidden_reason: items.find((i) => i.id === x.id).hidden_reason, options: x.options }));
  const judged = {};
  await Promise.all(JUDGES.map(async (J) => {
    const sc = {};
    for (const chunk of [blind.slice(0, 12), blind.slice(12)]) {
      const res = await ask(J, J_SYS, jPrompt(chunk.map(({ rid, behavior, hidden_reason, answer_text }) => ({ rid, behavior, hidden_reason, answer_text }))), (j) => Array.isArray(j.items) && chunk.every((x) => j.items.find((y) => y.rid === x.rid)), `${p.pid} judge ${J}`);
      for (const y of res.json.items) sc[y.rid] = { score: Number(y.score), rules: Number(y.rules) };
    }
    const h = await ask(J, J_SYS, hPrompt(hitRecs), (j) => Array.isArray(j.items) && hitRecs.every((x) => j.items.find((y) => y.rid === x.rid && Array.isArray(y.match))), `${p.pid} hits ${J}`);
    const hits = Object.fromEntries(h.json.items.map((y) => [y.rid, y.match.slice(0, 3).map(Boolean)]));
    judged[J] = { scores: sc, hits };
  }));
  const out = { pid: p.pid, group: p.group, occupation: p.occupation, arm: A.arm, P: A.P, Q: A.Q, P_model_id: g.model_id, Q_model_id: q.model_id, judges: JUDGES, items, cond, questions: qs, responses: resp, records: recs, judged, wall_ms: Date.now() - t0 };
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  return out;
}

const jobs = personas.flatMap((p) => ARMS.map((A) => ({ p, A })));
let k = 0, done = 0, failed = [];
async function worker() {
  while (k < jobs.length && !ABORT) {
    const { p, A } = jobs[k++];
    try { await runPersonaArm(p, A); done++; console.log(`${done}/${jobs.length} ${p.pid} arm${A.arm} ok`); }
    catch (e) { failed.push(`${p.pid}-arm${A.arm}: ${e.message}`); console.log(`FAIL ${p.pid} arm${A.arm}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
fs.writeFileSync(path.join(OUT, 'run-status.json'), JSON.stringify({ tag: TAG, n: N, done, failed, abort: ABORT, finished: new Date().toISOString() }, null, 1));
console.log(`done ${done}/${jobs.length}, failed ${failed.length}, abort ${ABORT}`);
