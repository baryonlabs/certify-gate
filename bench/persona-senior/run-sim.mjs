// 시니어 기술직 페르소나 행동-지식 간극 시뮬레이션 v2 (docs/PREREG_senior.md)
// 사용:
//   node bench/persona-senior/run-sim.mjs --phase 1 [--n 100] [--tag main]   # 생성 → 간극 탐지(a,b,d × 2모델) → 질문 생성 → 겨냥 채점
//   node bench/persona-senior/run-sim.mjs --phase calib [--tag main]         # 보정 표본 생성만(방법 (c) 임계값용)
//   node bench/persona-senior/run-sim.mjs --phase 2 [--n 100] [--tag main]   # 응답(B/A/A+) → 응답 채점
// 단계별 결과를 results/raw/<tag>/<pid>/<stage>.json에 저장하고, 다시 실행하면 이어서 한다.
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, parseJson } from '../llm.mjs';
import { bm25Scores } from './bm25.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const PHASE = arg('phase', '1'), N = Number(arg('n', 100)), TAG = arg('tag', 'main'), FROM = Number(arg('from', 0));
const VARIANT = arg('variant', 'normal');
const OUT = path.join(HERE, 'results', 'raw', TAG);
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'personas.json'), 'utf8'));
const personas = PHASE === 'calib' ? data.calibration : data.personas.slice(FROM, N);

export const ROLES = {
  P: 'claude-sonnet',
  Q: 'codex',
  DETECT: ['codex', 'gemini-argon'],
  JQ: ['gemini-argon', 'claude-sonnet'],
  JR: ['gemini-argon', 'gpt-luna'],
};
const LIMIT = { 'claude-sonnet': 8, codex: 6, 'gemini-argon': 6, 'gpt-luna': 5 };
const DEAD = {};

// 모델별 동시 실행 제한
const slots = {}, queue = {};
async function acquire(m) {
  slots[m] ??= 0; queue[m] ??= [];
  if (slots[m] < (LIMIT[m] ?? 4)) { slots[m]++; return; }
  await new Promise((r) => queue[m].push(r));
  slots[m]++;
}
function release(m) { slots[m]--; const n = queue[m].shift(); if (n) n(); }

function rng(seedStr) {
  let s = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2 ** 31, 7);
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
function shuffle(a, r) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const LIMIT_RE = /usage limit|hit your usage|rate limit|quota|429|exceeded|insufficient/i;
async function ask(model, sys, user, check, label) {
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (DEAD[model]) throw new Error(`${model} dead: ${DEAD[model]}`);
    await acquire(model);
    let r;
    try { r = await MODELS[model].call(sys, user); } finally { release(model); }
    if (r.error && LIMIT_RE.test(r.error) && !parseJson(r.text)) { DEAD[model] = r.error.slice(0, 200); throw new Error(`${model} usage limit: ${DEAD[model]}`); }
    const j = parseJson(r.text);
    if (j && (!check || check(j))) return { json: j, model_id: r.model_id, ms: r.ms, cost_usd: r.cost_usd };
    last = String(r.error ?? r.text).slice(0, 300);
  }
  throw new Error(`${label}: 해석 실패 (${model}) ${last}`);
}

function stageFile(pid, st) { return path.join(OUT, pid, `${st}.json`); }
function load(pid, st) { const f = stageFile(pid, st); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function save(pid, st, obj) { fs.mkdirSync(path.join(OUT, pid), { recursive: true }); fs.writeFileSync(stageFile(pid, st), JSON.stringify(obj, null, 1)); return obj; }
async function stage(pid, st, fn) { return load(pid, st) ?? save(pid, st, await fn()); }

const profile = (p) => `- 성별·나이: ${p.sex}, ${p.age}세\n- 지역: ${p.district}\n- 직업: ${p.occupation}\n- 학력: ${p.education_level}\n- 소개: ${p.persona}\n- 직업 생활: ${p.professional_persona}\n- 숙련: ${p.skills_and_expertise}`;
const jobContext = (p) => `직업: ${p.occupation}. ${p.professional_persona}`;

// ---------- 1. 생성 (P) ----------
const GEN_SYS = '너는 현장 숙련 기술자의 업무 지식과 판단을 사실적으로 구성하는 연구 보조자다. JSON 객체 하나만 출력한다.';
const genPrompt = (p) => `다음 사람의 프로필을 보라.\n${profile(p)}\n
이 사람의 직무에 대해 두 가지를 만들어라.

(1) knowledge: 이 직무의 **문서화된 기존 지식** 7개. 사내 표준·작업 매뉴얼·점검표·안전 규정 수준의 항목이다.
- 각 항목: id(K1~K7), title(20자 이내), text(1~2문장, 무엇을 언제 어떻게 하는지와 그 이유를 문서 문체로).
- 서로 다른 작업·대상을 다룬다.

(2) judgments: 이 사람이 실제 업무에서 **반복적으로** 내리는 판단 12개. 각 판단은
- type: "explained" | "partial" | "gap"
- behavior: 겉으로 관찰되는 행동만 쓴 한 문장(70자 이내). 이유·목적·기준을 쓰지 않는다("~하려고", "~때문에", "~위해" 금지). knowledge의 문장이나 표현을 그대로 옮기지 않는다. 모든 판단은 같은 문체와 비슷한 구체성(구체적 대상·장비·상황 포함)으로 쓴다.
- reason: 이 사람이 실제로 그렇게 하는 이유(1~2문장, 120자 이내).
- k_ref: 관련 knowledge id 또는 null.
정확히 다음 개수로 만든다.
- explained 4개: k_ref 항목이 이 행동의 이유·기준을 **명시적으로 진술**한다. reason은 그 항목 내용과 같다.
- partial 2개: k_ref 항목이 이 행동의 작업·대상은 다루지만, 이 사람이 쓰는 **판단 기준·조건(수치, 상황 조건, 예외)은 진술하지 않는다.** reason은 문서에 없는 그 기준이다.
- gap 6개: 어떤 knowledge 항목도 이 행동의 이유를 진술하지 않는다(k_ref = null). reason은 경험에서 나온, 매뉴얼에 없고 말로 정리해 본 적 없는 이 사람만의 구체적 판단 기준(조건·수치·겪은 사례 포함). 누구나 짐작하는 일반론(안전, 품질, 효율)은 피한다. gap 행동도 knowledge와 같은 업무 영역(같은 장비·공정·대상)에서 고른다.
12개 판단은 서로 다른 상황이며 type 순서를 섞어서 출력한다.
출력: {"knowledge":[{"id":"K1","title":"...","text":"..."}],"judgments":[{"type":"gap","behavior":"...","reason":"...","k_ref":null}]}`;

function validGen(j) {
  if (!Array.isArray(j.knowledge) || j.knowledge.length < 6 || j.knowledge.length > 8) return false;
  if (!Array.isArray(j.judgments) || j.judgments.length !== 12) return false;
  const c = { explained: 0, partial: 0, gap: 0 };
  const kids = new Set(j.knowledge.map((k) => k.id));
  for (const x of j.judgments) {
    if (!(x.type in c) || !x.behavior || !x.reason) return false;
    c[x.type]++;
    if (x.type !== 'gap' && !kids.has(x.k_ref)) return false;
  }
  return c.explained === 4 && c.partial === 2 && c.gap === 6;
}

async function generate(p) {
  return stage(p.pid, 'gen', async () => {
    const g = await ask(ROLES.P, GEN_SYS, genPrompt(p), validGen, `${p.pid} gen`);
    const knowledge = g.json.knowledge.map((k) => ({ id: String(k.id), title: String(k.title), text: String(k.text) }));
    const order = shuffle(g.json.judgments, rng(`${p.pid}-order`));
    const items = order.map((x, i) => ({ id: `J${String(i + 1).padStart(2, '0')}`, behavior: String(x.behavior) }));
    const gold = Object.fromEntries(order.map((x, i) => [items[i].id, { type: x.type, k_ref: x.type === 'gap' ? null : String(x.k_ref), reason: String(x.reason) }]));
    // ② 검색: 글자 2-gram BM25
    const retrieval = Object.fromEntries(items.map((it) => {
      const s = bm25Scores(it.behavior, knowledge.map((k) => `${k.title} ${k.text}`));
      const ranked = s.map((v, i) => ({ id: knowledge[i].id, score: v })).sort((a, b) => b.score - a.score);
      return [it.id, { top2: ranked.slice(0, 2).map((x) => x.id), max: ranked[0].score, scores: ranked }];
    }));
    return { pid: p.pid, model: ROLES.P, model_id: g.model_id, cost_usd: g.cost_usd, knowledge, items, gold, retrieval };
  });
}

// ---------- 2. 간극 탐지 ----------
const D_SYS = '너는 사람의 업무 행동이 기존 지식(문서화된 표준·매뉴얼)으로 설명되는지 판정하는 분석 에이전트다. JSON 객체 하나만 출력한다.';
const RULE = `판정 기준: 기존 지식 항목이 그 행동을 하는 **이유(판단 기준·조건)**를 진술하면 "explained". 항목이 그 작업이나 대상을 언급하기만 하고, 이 행동을 하게 만드는 기준·조건(수치, 상황 조건, 예외)을 진술하지 않으면 "gap"(행동-지식 간극). 관련 항목이 없어도 "gap".`;
const kText = (k) => `${k.id} ${k.title}: ${k.text}`;
const OUTFMT = `출력: {"items":[{"id":"J01","label":"explained 또는 gap","k":"이유를 진술한 항목 id 또는 null"}]} (모든 판단 포함)`;
const detPrompts = {
  a: (p, g) => `직무: ${p.occupation}\n각 판단(행동)마다, 그 행동 문장으로 기존 지식을 검색해 찾은 항목(최대 2개)이 함께 있다. 검색된 항목만 보고 판정하라.\n${RULE}\n
${g.items.map((it) => `[${it.id}] 행동: ${it.behavior}\n  검색된 기존 지식:\n${g.retrieval[it.id].top2.map((kid) => `   - ${kText(g.knowledge.find((k) => k.id === kid))}`).join('\n')}`).join('\n')}
${OUTFMT}`,
  b: (p, g) => `직무: ${p.occupation}\n이 직무의 기존 지식(문서화된 표준·매뉴얼) 전체:\n${g.knowledge.map((k) => `- ${kText(k)}`).join('\n')}\n
아래 각 판단(행동)이 위 기존 지식으로 설명되는지 판정하라.\n${RULE}\n
${g.items.map((it) => `[${it.id}] 행동: ${it.behavior}`).join('\n')}
${OUTFMT}`,
  d: (p, g) => `직무: ${p.occupation}\n이 직무의 기존 지식은 주어지지 않는다. 아래 각 판단(행동)이 이 직무의 일반적인 표준·매뉴얼로 설명될 만한 판단이면 "explained", 문서화되지 않은 개인 경험·암묵지에서 나온 판단일 것 같으면 "gap"으로 판정하라.\n
${g.items.map((it) => `[${it.id}] 행동: ${it.behavior}`).join('\n')}
출력: {"items":[{"id":"J01","label":"explained 또는 gap"}]} (모든 판단 포함)`,
};
const validDet = (g) => (j) => Array.isArray(j.items) && g.items.every((it) => j.items.find((y) => y.id === it.id && ['explained', 'gap'].includes(String(y.label).trim())));

async function detect(p, g) {
  const out = {};
  await Promise.all(ROLES.DETECT.flatMap((m) => Object.keys(detPrompts).map(async (meth) => {
    try {
      out[`${meth}|${m}`] = await stage(p.pid, `det-${meth}-${m}`, async () => {
        const r = await ask(m, D_SYS, detPrompts[meth](p, g), validDet(g), `${p.pid} det ${meth} ${m}`);
        return { method: meth, model: m, model_id: r.model_id, labels: Object.fromEntries(g.items.map((it) => { const y = r.json.items.find((z) => z.id === it.id); return [it.id, { label: String(y.label).trim(), k: y.k ?? null }]; })) };
      });
    } catch (e) { out[`${meth}|${m}`] = { error: e.message }; }
  })));
  return out;
}

// ---------- 3. 질문 생성 (Q, tools/expected-answers/prompt.md) ----------
const TEMPLATE = fs.readFileSync(path.join(HERE, '..', '..', 'tools', 'expected-answers', 'prompt.md'), 'utf8');
const T_HEAD = TEMPLATE.split('## 행동 문장')[0].trim();
const T_TASK = TEMPLATE.slice(TEMPLATE.indexOf('## 할 일'), TEMPLATE.indexOf('## 출력 형식')).trim();
const qPrompt = (p, g, ids) => `${T_HEAD}\n\n아래 ${ids.length}개 사례 각각에 대해 '할 일'을 따로 수행하라.\n\n${ids.map((id) => {
  const it = g.items.find((x) => x.id === id);
  return `### 사례 ${id}\n## 행동 문장(누가, 무엇을, 어떤 상황에서)\n${p.occupation}(${p.age}세)이 반복적으로 한 행동: ${it.behavior}\n## 조회한 온톨로지 항목(이 항목들은 행동의 이유·기준·조건을 진술하지 않는다)\n${g.retrieval[id].top2.map((kid) => `- ${kText(g.knowledge.find((k) => k.id === kid))}`).join('\n')}\n## 그 행동 직전의 대화 맥락\n${jobContext(p)}`;
}).join('\n\n')}\n\n${T_TASK}\n\n## 출력 형식(JSON만, 다른 글 없이)\n{"items":[{"id":"J01","question":"...","expected_answers":[{"perspective":"원칙","text":"..."},{"perspective":"조건","text":"..."},{"perspective":"기대 결과","text":"..."}]}]}`;
const validQ = (ids) => (j) => Array.isArray(j.items) && ids.every((id) => { const y = j.items.find((z) => z.id === id); return y && y.question && Array.isArray(y.expected_answers) && y.expected_answers.length >= 3 && y.expected_answers.every((a) => a && (a.text || typeof a === 'string')); });

function questionTargets(g, det) {
  const pos = g.items.filter((it) => g.gold[it.id].type !== 'explained').map((it) => it.id);
  const a = det[`a|${ROLES.Q}`];
  const fp = a?.labels ? g.items.filter((it) => g.gold[it.id].type === 'explained' && a.labels[it.id].label === 'gap').map((it) => it.id) : [];
  return [...pos, ...fp].sort();
}
async function questions(p, g, det) {
  const ids = questionTargets(g, det);
  return stage(p.pid, 'questions', async () => {
    const r = await ask(ROLES.Q, 'JSON 객체 하나만 출력한다.', qPrompt(p, g, ids), validQ(ids), `${p.pid} Q`);
    const qs = Object.fromEntries(ids.map((id) => { const y = r.json.items.find((z) => z.id === id); return [id, { question: String(y.question), options: y.expected_answers.slice(0, 3).map((a) => String(a.text ?? a)), perspectives: y.expected_answers.slice(0, 3).map((a) => a.perspective ?? null) }]; }));
    return { model: ROLES.Q, model_id: r.model_id, ids, qs };
  });
}

// ---------- 4. 질문 겨냥 채점 (J-q) ----------
const J_SYS = '너는 연구용 채점자다. 형식이나 길이가 아니라 내용으로만 판단한다. JSON 객체 하나만 출력한다.';
const tPrompt = (g, q, ids) => `각 기록에 사람의 '행동', 그 행동의 '숨은 이유'(실제 판단 기준), AI가 만든 '질문'과 '예상 답' 3개가 있다.
- target: 질문이 숨은 이유를 끌어내도록 겨냥했는가. 0 = 숨은 이유와 무관하거나 일반적인 '왜'만 묻는다, 1 = 숨은 이유가 다루는 영역은 묻지만 그 기준·조건까지는 겨냥하지 않는다, 2 = 숨은 이유가 다루는 기준·조건을 정확히 묻는다.
- match: 예상 답 3개 각각이 숨은 이유의 핵심 기준과 같은 내용인가(표현이 달라도 기준이 같으면 true, 일반론으로 일부만 겹치면 false).
${ids.map((id) => `[${id}] 행동: ${g.items.find((x) => x.id === id).behavior}\n  숨은 이유: ${g.gold[id].reason}\n  질문: ${q.qs[id].question}\n  0) ${q.qs[id].options[0]}\n  1) ${q.qs[id].options[1]}\n  2) ${q.qs[id].options[2]}`).join('\n')}
출력: {"items":[{"id":"J01","target":0,"match":[false,false,false]}]}`;
const validT = (ids) => (j) => Array.isArray(j.items) && ids.every((id) => { const y = j.items.find((z) => z.id === id); return y && [0, 1, 2].includes(Number(y.target)) && Array.isArray(y.match) && y.match.length >= 3; });
async function targetJudge(p, g, q) {
  const out = {};
  await Promise.all(ROLES.JQ.map(async (J) => {
    try {
      out[J] = await stage(p.pid, `jq-${J}`, async () => {
        const ids = shuffle(q.ids, rng(`${p.pid}-jq`));
        const r = await ask(J, J_SYS, tPrompt(g, q, ids), validT(ids), `${p.pid} jq ${J}`);
        return { judge: J, model_id: r.model_id, items: Object.fromEntries(ids.map((id) => { const y = r.json.items.find((z) => z.id === id); return [id, { target: Number(y.target), match: y.match.slice(0, 3).map((v) => v === true || v === 'true') }]; })) };
      });
    } catch (e) { out[J] = { error: e.message }; }
  }));
  return out;
}

// ---------- 5. 응답 (P, 새 세션) ----------
const CONDS = ['B', 'A', 'A+'];
function assignment(p, g) {
  const k = Number(p.pid.slice(1)) - 1;
  const gaps = g.items.filter((it) => g.gold[it.id].type === 'gap').map((it) => it.id).sort();
  const cond = {};
  for (let j = 0; j < 3; j++) for (const id of gaps.slice(2 * j, 2 * j + 2)) cond[id] = CONDS[(j + k) % 3];
  return cond;
}
const RUSHED = '\n[상황] 지금 매우 바쁘다. 이 설문은 귀찮은 업무 중 하나이고 빨리 끝내야 한다. 깊게 생각하지 말고 대충 빠르게 답하라.';
const R_SYS = (p) => `너는 아래 프로필의 사람 본인이다. 그 사람으로서 업무 지식 정리 설문에 답한다. JSON 객체 하나만 출력한다.\n${profile(p)}`;
const memory = (g, ids) => `당신이 평소 이 일들을 하는 실제 이유(당신의 기억, 말로 정리해 본 적은 없다):\n${ids.map((id) => `[${id}] ${g.items.find((x) => x.id === id).behavior} — ${g.gold[id].reason}`).join('\n')}`;
const show = (g, q, id, opts = true) => `[${id}] 행동: ${g.items.find((x) => x.id === id).behavior}\n  질문: ${q.qs[id].question}${opts ? `\n  0) ${q.qs[id].options[0]}\n  1) ${q.qs[id].options[1]}\n  2) ${q.qs[id].options[2]}` : ''}`;
const respPrompts = {
  B: (g, q, ids, rushed) => `${memory(g, ids)}${rushed ? RUSHED : ''}\n
각 항목에 당신의 행동과 AI의 질문이 있다. 질문에 대한 답(그렇게 하는 이유)을 직접 적어라.
${ids.map((id) => show(g, q, id, false)).join('\n')}
출력: {"answers":[{"id":"J01","text":"..."}]}`,
  A: (g, q, ids, rushed) => `${memory(g, ids)}${rushed ? RUSHED : ''}\n
각 항목에 당신의 행동, AI의 질문, AI가 만든 예상 답 3개가 있다. 이 화면에는 글을 입력하는 칸이 없다. 고르기만 할 수 있다.
- picks: 당신의 실제 이유와 맞는 예상 답 번호(0,1,2, 복수 가능)
- none_correct: 맞는 것이 하나도 없으면 true(이때 picks는 빈 배열)
${ids.map((id) => show(g, q, id)).join('\n')}
출력: {"answers":[{"id":"J01","picks":[0],"none_correct":false}]}`,
  'A+': (g, q, ids, rushed) => `${memory(g, ids)}${rushed ? RUSHED : ''}\n
각 항목에 당신의 행동, AI의 질문, AI가 만든 예상 답 3개가 있다.
- picks: 당신의 실제 이유와 맞는 예상 답 번호(0,1,2, 복수 가능)
- none_correct: 맞는 것이 하나도 없으면 true(이때 picks는 빈 배열)
- supplement(필수): 예상 답을 골랐다면 "어떤 조건에서 그런가"를 한 문장으로 적는다. '모두 틀림'이면 실제 이유를 직접 적는다. 비워 둘 수 없다.
${ids.map((id) => show(g, q, id)).join('\n')}
출력: {"answers":[{"id":"J01","picks":[0],"none_correct":false,"supplement":"..."}]}`,
};
const validR = (c, ids) => (j) => Array.isArray(j.answers) && ids.every((id) => { const y = j.answers.find((z) => z.id === id); if (!y) return false; if (c === 'B') return typeof y.text === 'string' && y.text.trim(); if (c === 'A+') return typeof y.supplement === 'string' && y.supplement.trim(); return Array.isArray(y.picks) || y.none_correct; });
function answerText(c, ans, q) {
  if (c === 'B') return String(ans.text ?? '').trim();
  const picks = ans.none_correct ? [] : [...new Set((ans.picks ?? []).map(Number).filter((k) => [0, 1, 2].includes(k)))].map((k) => q.options[k].replace(/[.。]\s*$/, ''));
  const parts = [...picks];
  if (c === 'A+' && String(ans.supplement ?? '').trim()) parts.push(String(ans.supplement).trim());
  return parts.join('. ');
}
async function respond(p, g, q, variant) {
  const cond = assignment(p, g);
  return stage(p.pid, `resp-${variant}`, async () => {
    const res = {};
    await Promise.all(CONDS.map(async (c) => {
      const ids = Object.keys(cond).filter((id) => cond[id] === c).sort();
      const r = await ask(ROLES.P, R_SYS(p), respPrompts[c](g, q, ids, variant === 'rushed'), validR(c, ids), `${p.pid} resp ${c}`);
      for (const id of ids) res[id] = r.json.answers.find((z) => z.id === id);
    }));
    const records = Object.keys(cond).sort().map((id) => {
      const c = cond[id], ans = res[id];
      return { rid: `${id}-${variant}`, id, cond: c, variant, answer: ans, answer_text: answerText(c, ans, q.qs[id]),
        typed_chars: c === 'B' ? String(ans.text ?? '').length : c === 'A+' ? String(ans.supplement ?? '').length : 0,
        none_correct: !!ans.none_correct, picks: ans.none_correct ? [] : (ans.picks ?? []).map(Number) };
    });
    return { model: ROLES.P, cond, records };
  });
}

// ---------- 6. 응답 채점 (J-r, 조건 모름) ----------
const rPrompt = (g, q, recs) => `각 기록에 사람의 '행동', '정답 이유'(그 사람의 실제 판단 기준), 그 사람에게 보여 준 '예상 답' 3개, 그 사람의 최종 '응답'이 있다. 응답이 정답 이유를 얼마나 담았는지 채점하라.
- score: 0 = 정답 이유의 핵심 기준이 없음(또는 다른 이유), 1 = 일부만 담음, 2 = 핵심 기준(조건·수치 포함)을 담음
- rules: 응답에 들어 있는 서로 다른 판단 규칙(기준)의 개수(정수, 정답 여부와 무관, 빈 응답은 0)
- novel: 응답에 예상 답 3개에 없는 판단 기준(조건·수치·예외)이 들어 있으면 true
${recs.map((r) => `[${r.rid}] 행동: ${g.items.find((x) => x.id === r.id).behavior}\n  정답 이유: ${g.gold[r.id].reason}\n  예상 답: 0) ${q.qs[r.id].options[0]} / 1) ${q.qs[r.id].options[1]} / 2) ${q.qs[r.id].options[2]}\n  응답: ${r.answer_text || '(빈 응답)'}`).join('\n')}
출력: {"items":[{"rid":"...","score":0,"rules":0,"novel":false}]}`;
async function respJudge(p, g, q, resp, variant) {
  const out = {};
  await Promise.all(ROLES.JR.map(async (J) => {
    try {
      out[J] = await stage(p.pid, `jr-${variant}-${J}`, async () => {
        const recs = shuffle(resp.records, rng(`${p.pid}-jr-${variant}`)).map(({ rid, id, answer_text }) => ({ rid, id, answer_text }));
        const r = await ask(J, J_SYS, rPrompt(g, q, recs), (j) => Array.isArray(j.items) && recs.every((x) => j.items.find((y) => y.rid === x.rid && [0, 1, 2].includes(Number(y.score)))), `${p.pid} jr ${J}`);
        return { judge: J, model_id: r.model_id, items: Object.fromEntries(recs.map((x) => { const y = r.json.items.find((z) => z.rid === x.rid); return [x.rid, { score: Number(y.score), rules: Number(y.rules ?? 0), novel: y.novel === true || y.novel === 'true' }]; })) };
      });
    } catch (e) { out[J] = { error: e.message }; }
  }));
  return out;
}

// ---------- 실행 ----------
async function runPersona(p) {
  const t0 = Date.now();
  const g = await generate(p);
  if (PHASE === 'calib') return 'gen';
  if (PHASE === '1') {
    const det = await detect(p, g);
    const q = await questions(p, g, det);
    const jq = await targetJudge(p, g, q);
    const errs = [...Object.values(det), ...Object.values(jq)].filter((x) => x.error).map((x) => x.error);
    return errs.length ? `partial (${errs.length} err: ${errs[0].slice(0, 120)})` : `ok ${((Date.now() - t0) / 1000).toFixed(0)}s`;
  }
  const q = load(p.pid, 'questions');
  if (!q) throw new Error('questions 없음(phase 1 먼저)');
  const resp = await respond(p, g, q, VARIANT);
  const jr = await respJudge(p, g, q, resp, VARIANT);
  const errs = Object.values(jr).filter((x) => x.error).map((x) => x.error);
  return errs.length ? `partial (${errs[0].slice(0, 120)})` : `ok ${((Date.now() - t0) / 1000).toFixed(0)}s`;
}

const CONC = Number(arg('conc', 10));
let k = 0; const status = {};
async function worker() {
  while (k < personas.length) {
    const p = personas[k++];
    try { status[p.pid] = await runPersona(p); } catch (e) { status[p.pid] = `FAIL ${e.message.slice(0, 200)}`; }
    console.log(new Date().toTimeString().slice(0, 8), p.pid, status[p.pid], JSON.stringify(DEAD));
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `run-status-${PHASE}${PHASE === '2' ? '-' + VARIANT : ''}.json`), JSON.stringify({ tag: TAG, phase: PHASE, n: personas.length, status, dead: DEAD, finished: new Date().toISOString() }, null, 1));
console.log('done', Object.values(status).filter((s) => s.startsWith('ok') || s === 'gen').length, '/', personas.length, 'dead', JSON.stringify(DEAD));
