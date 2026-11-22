// v2 어려운 과제 세트 생성 (결정적, 규칙 기반)
// 사용: node bench/v2/build-hard.mjs [SciFact corpus.jsonl] [--exclude bench/v2/pilot-exclude.json]
//  - 정본은 커밋된 tasks.json/truth.json. 재생성에는 SciFact 전체 corpus.jsonl과 --exclude bench/v2/pilot-exclude.json --drop bench/v2/pilot-drop.json 이 필요(corpus_subset.jsonl은 사용 초록 보관용·라이선스 표기용)
// 출력: bench/v2/tasks.json(정답 없음), bench/v2/truth.json, bench/v2/data/corpus_subset.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { splitSentences, numbersIn } from '../../src/align.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const exclIdx = argv.indexOf('--exclude');
const EXCLUDE = new Set(exclIdx >= 0 ? JSON.parse(fs.readFileSync(argv[exclIdx + 1], 'utf8')) : []);
const dropIdx = argv.indexOf('--drop');
const DROP = new Set(dropIdx >= 0 ? JSON.parse(fs.readFileSync(argv[dropIdx + 1], 'utf8')) : []);
const corpusPath = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--exclude' && argv[i - 1] !== '--drop');
const SUBSET = path.join(HERE, 'data', 'corpus_subset.jsonl');
const SUMMARY_CHARS = 160; // 접힌 요약(140자)보다 여유를 둔다

let seed = 20271201;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const docs = (corpusPath ? fs.readFileSync(corpusPath, 'utf8') : fs.readFileSync(SUBSET, 'utf8'))
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .map((d) => ({ ...d, text: d.abstract.map((s) => s.trim()).join(' ') }))
  .filter((d) => d.text.length >= 600 && d.text.length <= 2000 && d.abstract.length >= 5)
  .sort((a, b) => a.doc_id - b.doc_id);

// ── 문장 규칙 ─────────────────────────────────────────────────────────
const HEADER = /^(BACKGROUND|METHODS?|RESULTS?|CONCLUSIONS?|OBJECTIVES?|FINDINGS|INTERPRETATION|PURPOSE|DESIGN|SETTING|PARTICIPANTS|MAIN OUTCOME MEASURES?|CONTEXT|AIMS?|INTRODUCTION|SIGNIFICANCE)\b[\s:]*/;
const clean = (s) => s.replace(HEADER, '').replace(HEADER, '').trim();

/** 의미를 바꾸지 않는 패러프레이즈 (정상·오류 항목 모두에 적용). 함정 표기 포함. */
function paraphrase(s, { trap = false } = {}) {
  let t = clean(s);
  const R = [
    [/^Here,? we (show|report|demonstrate|find) that /i, 'The authors $1 that '],
    [/^In this study,? we /i, 'The authors '],
    [/^We (found|show|showed|report|demonstrate|demonstrated|observed|identified) that /i, 'The study $1 that '],
    [/^We /, 'The authors '],
    [/\bwe /g, 'the authors '],
    [/^However, /, ''], [/^Moreover, /, 'Furthermore, '], [/^In addition, /, 'Additionally, '],
    [/\bapproximately\b/g, 'about'], [/\bdemonstrate\b/g, 'show'], [/\bdemonstrated\b/g, 'showed'],
    [/\bhigher than\b/g, 'greater than'],
    [/\butilized?\b/g, 'used'], [/\bin order to\b/g, 'to'],
  ];
  for (const [a, b] of R) t = t.replace(a, b);
  t = t.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1');
  if (trap) {
    // 같은 수의 다른 표기 → 강조기가 '원문에 없음'으로 오경고할 수 있는 함정
    t = t.replace(/\b(two|three|four)[- ]fold\b/gi, (m, w) => `${{ two: 2, three: 3, four: 4 }[w.toLowerCase()]}-fold`)
      .replace(/\b(\d{1,3}),(\d{3})\b/, '$1$2')
      .replace(/(\d+(?:\.\d+)?)%/, '$1 percent');
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const NUM = /(?<![A-Za-z\d.*\-])(\d[\d,]*(?:\.\d+)?)(?![A-Za-z\d])/g;
const isYear = (n) => /^(19[5-9]\d|20[0-2]\d)$/.test(n);
function numbersWithPos(s) {
  return [...s.matchAll(NUM)].map((m) => ({ tok: m[1], i: m.index })).filter((x) => !/%\s*(CI|confidence)/i.test(s.slice(x.i + x.tok.length, x.i + x.tok.length + 14)));
}
const MUT = {
  digit(s) {
    const c = numbersWithPos(s).filter((x) => !isYear(x.tok) && !x.tok.includes('.') && x.tok.replace(/,/g, '').length >= 1);
    if (!c.length) return null;
    const x = pick(c);
    const digits = [...x.tok].map((ch, k) => (/\d/.test(ch) ? k : -1)).filter((k) => k >= 0);
    const k = digits.length > 1 ? pick(digits.slice(1)) : digits[0];
    const d = Number(x.tok[k]);
    let nd = (d + 1 + Math.floor(rnd() * 8)) % 10;
    if (digits.length === 1 && nd === 0) nd = (d + 2) % 10 || 3;
    const nt = x.tok.slice(0, k) + nd + x.tok.slice(k + 1);
    return { text: s.slice(0, x.i) + nt + s.slice(x.i + x.tok.length), from: x.tok, to: nt };
  },
  decimal(s) {
    const c = numbersWithPos(s).filter((x) => /^\d+\.\d+$/.test(x.tok));
    if (!c.length) return null;
    const x = pick(c);
    const [a, b] = x.tok.split('.');
    let nt;
    if (b.length >= 2 && b[0] !== b[1]) nt = `${a}.${b[1]}${b[0]}${b.slice(2)}`;
    else if (a.length >= 1 && a[a.length - 1] !== b[0]) nt = `${a.slice(0, -1)}${b[0]}.${a[a.length - 1]}${b.slice(1)}`; // 46.9 → 49.6
    else return null;
    if (nt === x.tok) return null;
    return { text: s.slice(0, x.i) + nt + s.slice(x.i + x.tok.length), from: x.tok, to: nt };
  },
  unit(s) {
    const U = { mg: 'g', g: 'mg', kg: 'g', mm: 'cm', cm: 'mm', ml: 'L', mL: 'L', days: 'weeks', weeks: 'months', months: 'years', hours: 'minutes', minutes: 'hours', h: 'min', min: 'h', μg: 'mg', µg: 'mg', nm: 'μm', mmol: 'mol' };
    const m = s.match(/(\d)\s?(mg|kg|g|mm|cm|mL|ml|days|weeks|months|hours|minutes|μg|µg|nm|mmol|h|min)\b/);
    if (!m) return null;
    const i = m.index + m[1].length;
    const pre = s.slice(i).match(/^\s?/)[0];
    const to = U[m[2]];
    return { text: s.slice(0, i) + pre + to + s.slice(i + pre.length + m[2].length), from: m[2], to };
  },
  year(s) {
    const c = numbersWithPos(s).filter((x) => isYear(x.tok));
    if (!c.length) return null;
    const x = pick(c);
    const nt = String(Number(x.tok) + pick([-3, -2, 2, 3]));
    return { text: s.slice(0, x.i) + nt + s.slice(x.i + x.tok.length), from: x.tok, to: nt };
  },
  scope(s) {
    const P = [/ in (?:male |female |adult |aged |young |transgenic |wild-type |obese |diabetic |pregnant |postmenopausal )?(?:mice|rats|women|men|children|adults|infants|older adults|elderly patients|girls|boys)(?=[ ,.;])/, /(?<!both) in vitro(?=[,.;]| (?!and))/];
    for (const p of P) {
      const m = s.match(p);
      if (m && s.replace(m[0], '').length > 40) return { text: s.replace(m[0], '').replace(/,\s*,/g, ',').replace(/\s+([,.;])/g, '$1'), from: m[0].trim(), to: '(삭제)' };
    }
    return null;
  },
  causal(s) {
    const R = [
      [/\b(is|was) (?:significantly |positively |negatively |inversely |independently |strongly )?(?:associated|correlated) with\b/, (m, v) => (v === 'is' ? 'causes' : 'caused')],
      [/\b(are|were) (?:significantly |positively |negatively |inversely |independently |strongly )?(?:associated|correlated) with\b/, (m, v) => (v === 'are' ? 'cause' : 'caused')],
      [/\b(?:is|was|are|were) linked to\b/, () => 'directly causes'],
      [/\bsuggests? that\b/, (m) => (m.startsWith('suggests') ? 'proves that' : 'prove that')],
      [/\bsuggesting that\b/, () => 'proving that'],
      [/\bmay\b/, () => 'will'], [/\bmight\b/, () => 'will'], [/\bcould\b/, () => 'will'],
      [/\bcontribute[sd]? to\b/, () => 'is the sole cause of'],
    ];
    for (const [p, f] of R) {
      const m = s.match(p);
      if (m) { const to = m[0].replace(p, f); return { text: s.replace(p, f), from: m[0], to }; }
    }
    return null;
  },
};

// ── 항목 생성 ─────────────────────────────────────────────────────────
function anchors(d) {
  let off = 0;
  const out = [];
  d.abstract.forEach((raw, i) => {
    const s = raw.trim();
    if (off > SUMMARY_CHARS && i >= 1 && clean(s).length >= 60 && clean(s).length <= 320 && !/^(\(|\[)/.test(s)) out.push({ i, s });
    off += s.length + 1;
  });
  return out;
}

const PLAN = { digit: 8, decimal: 6, unit: 6, year: 5, scope: 8, causal: 8, edition: 3 };
const N_CORRECT = 44, N_TRAP = 12, N_CORRECT_EDITION = 3;
const items = [];
const usedDocs = new Set();
const byType = {};

function makeItem(d, type, { correctEdition = false, trap = false } = {}) {
  const an = anchors(d);
  if (an.length < 3) return null;
  const k = Math.min(an.length, 2 + Math.floor(rnd() * 2));
  // 문장 순서는 원문 순서 유지
  const idxs = [];
  while (idxs.length < k) { const a = pick(an); if (!idxs.includes(a)) idxs.push(a); }
  idxs.sort((x, y) => x.i - y.i);
  let sentences = idxs.map((a) => paraphrase(a.s, { trap }));
  let sources = [{ key: `scifact-doc:${d.doc_id}`, label: `${d.title} (S2ORC 초록, SciFact corpus)`, edition: null, kind: 'excerpt', url: null, text: d.text }];
  let truth = { label: 'correct', error_type: null, mutated_idx: null, keys: [], trap };
  if (type === 'edition' || correctEdition) {
    // 사전 인쇄본: 한 문장의 숫자 한 자리가 다름. 최종 출판본이 기준.
    const cand = idxs.map((a, j) => ({ a, j, m: MUT.digit(a.s) })).filter((x) => x.m);
    if (!cand.length) return null;
    const c = pick(cand);
    const preprint = d.text.replace(c.a.s.trim(), c.m.text);
    if (preprint === d.text) return null;
    sources = [
      { key: `scifact-doc:${d.doc_id}:preprint`, label: `${d.title} — 사전 인쇄본`, edition: '사전 인쇄본(v1)', kind: 'excerpt', url: null, text: preprint },
      { key: `scifact-doc:${d.doc_id}:published`, label: `${d.title} — 최종 출판본`, edition: '최종 출판본', kind: 'excerpt', url: null, text: d.text },
    ];
    if (type === 'edition') {
      sentences[c.j] = paraphrase(c.m.text, { trap: false });
      truth = { label: 'error', error_type: 'edition', mutated_idx: c.j, from: c.m.from, to: c.m.to, keys: [c.m.from, c.m.to, '출판', 'publish', '판본', 'preprint'] };
    }
    return { sentences, sources, truth };
  }
  if (type === 'correct') return { sentences, sources, truth };
  const cand = idxs.map((a, j) => ({ j, m: MUT[type](a.s) })).filter((x) => x.m && x.m.text !== x.m.from);
  if (!cand.length) return null;
  const c = pick(cand);
  const mutated = paraphrase(c.m.text);
  if (mutated === sentences[c.j]) return null;
  sentences[c.j] = mutated;
  const kw = { digit: ['숫자', 'number'], decimal: ['소수', 'decimal'], unit: ['단위', 'unit'], year: ['연도', 'year'], scope: ['범위', '조건', '대상', 'scope', 'only', '일반화'], causal: ['인과', 'caus', '과장', 'prove', '단정'] }[type];
  truth = { label: 'error', error_type: type, mutated_idx: c.j, from: c.m.from, to: c.m.to, keys: [c.m.from, ...(type === 'scope' ? [] : [c.m.to]), ...kw].filter(Boolean) };
  return { sentences, sources, truth };
}

const order = [...docs];
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
function fill(type, n, opts = {}) {
  let got = 0;
  for (const d of order) {
    if (got >= n) break;
    if (usedDocs.has(d.doc_id) || EXCLUDE.has(`${d.doc_id}`)) continue;
    const it = makeItem(d, type, opts);
    if (!it) continue;
    // 정상 함정 항목은 실제로 표기가 바뀐 경우만
    if (opts.trap && it.sentences.every((s, j) => !/\d-fold|\d percent|\d{4,}/.test(s))) continue;
    usedDocs.add(d.doc_id);
    items.push({ ...it, doc: d });
    byType[opts.correctEdition ? 'correct_edition' : opts.trap ? 'correct_trap' : type] = (byType[opts.correctEdition ? 'correct_edition' : opts.trap ? 'correct_trap' : type] ?? 0) + 1;
    got++;
  }
  if (got < n) console.warn(`경고: ${type}${opts.trap ? '(trap)' : ''} ${got}/${n}`);
}
for (const [t, n] of Object.entries(PLAN)) fill(t, n);
fill('correct', N_TRAP, { trap: true });
fill('correct', N_CORRECT_EDITION, { correctEdition: true });
fill('correct', N_CORRECT - N_TRAP - N_CORRECT_EDITION - 1); // 1개는 ontology 정상 항목

// ── ontology 실제 사례: 15%(확인됨) vs 출판본 14% + 정상 1개 ─────────────
const v1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tasks.json'), 'utf8')).items;
const v1truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'truth.json'), 'utf8'));
const fromV1 = (origin) => v1.find((x) => v1truth[x.id].source_origin === origin);
const sc = fromV1('ontology:skill_compression');
items.push({ sentences: sc.sentences, sources: sc.sources.map((s) => ({ ...s, edition: s.edition.includes('QJE') ? '최종 출판본(QJE 2025)' : '워킹페이퍼(이전 판본)' })), truth: { label: 'error', error_type: 'edition', mutated_idx: 0, from: '15', to: '14', keys: ['14', '15', '출판', 'QJE', '판본'], real_case: true }, label: sc.label, origin: 'ontology:skill_compression' });
const jf = fromV1('ontology:jagged_frontier');
items.push({ sentences: jf.sentences, sources: jf.sources, truth: { label: 'correct', error_type: null, keys: [] }, label: jf.label, origin: 'ontology:jagged_frontier' });

// ── 섞고 ID 부여 ──────────────────────────────────────────────────────
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
const tasks = [], truth = {};
items.forEach((it, n) => {
  const id = `H${String(n + 1).padStart(3, '0')}`;
  const label = it.label ?? `SciFact 초록 #${it.doc.doc_id}`;
  tasks.push({ id, label, definition: it.sentences.join(' '), status: 'verified', sentences: it.sentences, sources: it.sources });
  truth[id] = { ...it.truth, origin: it.origin ?? `scifact-doc:${it.doc.doc_id}`, n_sentences: it.sentences.length, source_chars: it.sources.reduce((a, s) => a + s.text.length, 0) };
  for (const s of it.sentences) if (!s || s.length < 10) throw new Error(`${id} 빈 문장`);
});
// 마지막 파일럿 라운드의 바닥 항목은 교체 없이 제외(ID 유지)
for (const id of DROP) { const k = tasks.findIndex((t) => t.id === id); if (k >= 0) tasks.splice(k, 1); delete truth[id]; }
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });
if (corpusPath) {
  const used = docs.filter((d) => usedDocs.has(d.doc_id) || EXCLUDE.has(`${d.doc_id}`));
  // 교체 후보 재생성을 위해 여분 초록도 함께 저장(사용 + 다음 후보 120개)
  const extra = order.filter((d) => !usedDocs.has(d.doc_id)).slice(0, 120);
  fs.writeFileSync(SUBSET, [...used, ...extra].sort((a, b) => a.doc_id - b.doc_id).map((d) => JSON.stringify({ doc_id: d.doc_id, title: d.title, abstract: d.abstract })).join('\n') + '\n');
}
fs.writeFileSync(path.join(HERE, 'tasks.json'), JSON.stringify({ _doc: 'v2 어려운 세트(정답 없음). bench/v2/build-hard.mjs로 생성', items: tasks }, null, 1));
fs.writeFileSync(path.join(HERE, 'truth.json'), JSON.stringify(truth, null, 1));
const lab = Object.values(truth).reduce((a, t) => ((a[t.label] = (a[t.label] ?? 0) + 1), a), {});
const lens = Object.values(truth).map((t) => t.source_chars);
console.log(tasks.length, 'items', lab, byType, `source chars ${Math.min(...lens)}–${Math.max(...lens)}`);
