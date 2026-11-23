// 벤치마크 과제 세트 생성: SciFact 27 + ontology.json 실제 항목 16 (판본 사례 포함: 초안 14%=워킹페이퍼 vs 출판본 15%) = 43
// 출력: bench/tasks.json (서버가 읽는 항목, 정답 없음), bench/truth.json (정답·오류 유형, 서버는 읽지 않음)
import fs from 'node:fs';
import { termToItem } from '../src/ontology.js';
import { splitSentences } from '../src/align.js';

const here = (p) => new URL(p, import.meta.url);
const sf = new Map(fs.readFileSync(here('./data/scifact_subset.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((o) => [`${o.split}${o.claim_id}`, o]));
const onto = JSON.parse(fs.readFileSync(here('../data/seed/ontology.json'), 'utf8'));
const sdb = JSON.parse(fs.readFileSync(here('../data/seed/sources.json'), 'utf8'));

// ── SciFact: 정상(원 SUPPORT 주장 그대로) ─────────────────────────────
const SF_CORRECT = ['dev53', 'dev1185', 'train22', 'train854', 'train1148', 'dev208', 'dev279', 'dev137', 'dev217', 'dev298', 'dev50', 'dev230', 'dev148', 'dev70'];
// ── SciFact: 오류 (심은 오류 + 원 CONTRADICT 주장) ─────────────────────
const SF_ERRORS = {
  train919: { type: 'number', draft: 'Participants who quit smoking reduce lung cancer risk by approximately 80%.', keys: ['80', '50', '0.5', 'HR'] },
  dev5: { type: 'number', draft: '1/200 in UK have abnormal PrP positivity.', keys: ['200', '493', '2000', '2,000'] },
  train564: { type: 'number', draft: 'In British Men, haplogroup I increases risk of cardiovascular disease by 100%.', keys: ['100', '50'] },
  dev163: { type: 'number', draft: 'Bariatric surgery is associated with a 40%-90% decrease in the severity of depressive symptoms.', keys: ['90', '70'] },
  train1297: { type: 'year', draft: 'In 2015, an estimated 11.9 million episodes of severe acute lower respiratory infection resulted in hospital admissions of young children worldwide.', keys: ['2015', '2010'] },
  dev386: { type: 'causal', draft: 'Bolus administration causes most peripheral IV drug administration errors. Eliminating bolus doses would remove the majority of errors.', keys: ['cause', 'probably', 'eliminat', 'remove', '인과', '과장', '단정'] },
  dev380: { type: 'causal', draft: 'Enhanced early production of inflammatory chemokines by memory CD4+ T cells guarantees complete clearance of influenza virus from the lung.', keys: ['guarantee', 'complete', 'clearance', 'early control', '과장', '보장', '완전'] },
  dev100: { type: 'unsupported', append: 'This random segregation pattern was also confirmed in human bone marrow samples.', keys: ['human', '인간', '사람', '출처에 없', '근거 없', 'not mentioned', 'not supported'] },
  dev327: { type: 'unsupported', append: 'Deletion of αvβ8 also extended the lifespan of the mice.', keys: ['lifespan', '수명', '출처에 없', '근거 없', 'not mentioned', 'not supported'] },
  dev51: { type: 'contradiction', keys: ['poor', 'better', '반대', '예후'] },
  dev216: { type: 'contradiction', keys: ['promot', 'impair', '반대', '촉진'] },
  dev274: { type: 'contradiction', keys: ['not significant', 'significantly different', '.11', '0.11', '유의'] },
  dev513: { type: 'contradiction', keys: ['low fitness', 'cause', '반대', '낮은'] },
};

// ── ontology.json 실제 항목 ───────────────────────────────────────────
const ON_CORRECT = ['gettier_problem', 'ontology_spec', 'knowledge_spillover', 'effectuation', 'jagged_frontier', 'epistemic_monoculture', 'jtb', 'hitl'];
const ON_ERRORS = {
  seci: { type: 'unsupported', native: true, keys: ['Ba', '장', '출처에 없', '근거 없', '언급'] },
  collective_tacit: { type: 'unsupported', native: true, keys: ['Collins', 'Polanyi', '출처에 없', '근거 없', '다른 출처'] },
  skill_compression: { type: 'edition', native: true, keys: ['15', '14', '출판', '판본', 'QJE'] }, // 2026-11-23 정정: 초안 14%(워킹페이퍼), 출판본 15%
  transaction_cost: { type: 'year', from: '1937', to: '1973', keys: ['1973', '1937'] },
  tacit_knowledge: { type: 'year', from: '1958', to: '1962', keys: ['1962', '1958'] },
  certification_premium: { type: 'number', from: '56%', to: '65%', keys: ['65', '56'] },
};
const ON_CONTESTED = ['autonomy', 'working_knowledge'];

const items = [];
const truth = {};
const sfItem = (key, draft) => {
  const o = sf.get(key);
  if (!o) throw new Error(`SciFact ${key} 없음`);
  return {
    label: `SciFact 주장 #${o.claim_id}`,
    definition: draft,
    status: 'verified',
    sentences: splitSentences(draft),
    sources: [{ key: `scifact:${o.doc_id}`, label: `${o.title} (S2ORC 초록 발췌, SciFact)`, edition: null, kind: 'excerpt', url: null, text: o.rationale }],
    origin: `scifact:${key}`,
  };
};
for (const k of SF_CORRECT) {
  const o = sf.get(k);
  if (o.label !== 'SUPPORT') throw new Error(`${k}는 SUPPORT가 아님`);
  items.push({ ...sfItem(k, o.claim), _truth: { label: 'correct', origin: 'scifact', keys: [] } });
}
for (const [k, e] of Object.entries(SF_ERRORS)) {
  const o = sf.get(k);
  let draft = e.draft ?? o.claim;
  if (e.append) draft = `${o.claim.trim().replace(/\.?$/, '.')} ${e.append}`;
  if (e.type === 'contradiction' && o.label !== 'CONTRADICT') throw new Error(`${k}는 CONTRADICT가 아님`);
  items.push({ ...sfItem(k, draft), _truth: { label: 'error', error_type: e.type, origin: 'scifact', planted: e.type !== 'contradiction', keys: e.keys } });
}
const termById = new Map(onto.terms.map((t) => [t.id, t]));
const onItem = (id, mutate) => {
  const t = { ...termById.get(id) };
  if (mutate) {
    if (!t.definition.includes(mutate.from)) throw new Error(`${id}: ${mutate.from} 없음`);
    t.definition = t.definition.replace(mutate.from, mutate.to);
  }
  if (ON_CONTESTED.includes(id)) t.status = 'draft';
  else t.status = 'verified';
  const it = termToItem(t, sdb);
  // 벤치에서는 조건 간 표시를 같게 하려고 '재구성 발췌' 표기를 없앤다(정답은 화면에 보이는 원문 기준)
  const sources = it.sources.map((s) => ({ ...s, kind: 'excerpt' }));
  return { label: it.label, definition: it.definition, status: it.status, sentences: it.sentences, sources, interpretations: it.interpretations, origin: `ontology:${id}` };
};
for (const id of ON_CORRECT) items.push({ ...onItem(id), _truth: { label: 'correct', origin: 'ontology', keys: [] } });
for (const [id, e] of Object.entries(ON_ERRORS)) items.push({ ...onItem(id, e.from ? e : null), _truth: { label: 'error', error_type: e.type, origin: 'ontology', planted: !e.native, keys: e.keys } });
for (const id of ON_CONTESTED) items.push({ ...onItem(id), _truth: { label: 'contested', origin: 'ontology', keys: ['해석', '쟁점'] } });

// 결정적 섞기 후 불투명 ID 부여(정답이 ID에 새지 않도록)
let seed = 20271122;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
items.sort(() => 0);
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
const out = items.map((it, i) => {
  const id = `T${String(i + 1).padStart(2, '0')}`;
  const { _truth, origin, ...rest } = it;
  truth[id] = { ..._truth, source_origin: origin, n_sentences: it.sentences.length };
  return { id, ...rest };
});
for (const it of out) if (it.sentences.length === 0) throw new Error(`${it.id} 문장 없음`);
fs.writeFileSync(here('./tasks.json'), JSON.stringify({ _doc: '벤치마크 항목(정답 없음). bench/build-tasks.mjs로 생성', items: out }, null, 1));
fs.writeFileSync(here('./truth.json'), JSON.stringify(truth, null, 1));
const c = Object.values(truth).reduce((a, t) => ((a[t.label] = (a[t.label] ?? 0) + 1), a), {});
const types = Object.values(truth).filter((t) => t.error_type).reduce((a, t) => ((a[t.error_type] = (a[t.error_type] ?? 0) + 1), a), {});
console.log(out.length, 'items', c, types);
