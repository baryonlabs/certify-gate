// 예상 답 생성기(논문 3장 ④): 행동 문장 + 조회한 온톨로지 항목 + 직전 대화 맥락 → 질문 1개 + 서로 다른 관점의 예상 답 3개(각 40자 이내)
// 사용:
//   node tools/expected-answers/generate.mjs tools/expected-answers/example.json            # 프롬프트만 출력(기본, 네트워크 없음)
//   node tools/expected-answers/generate.mjs input.json --ontology data/seed/ontology.json    # 온톨로지 파일 지정
//   CG_LLM=1 node tools/expected-answers/generate.mjs input.json                              # Claude 호출(선택)
// 입력 JSON: { behavior, context?, ontology_items?: [{id,label,definition}], ontology_query_terms?: [문자열] }
//   ontology_items가 없으면 ontology_query_terms(없으면 behavior의 낱말)로 ontology.json의 terms를 단어 일치로 조회한다(최대 5개).
// LLM 호출: CG_LLM=1일 때만. `npm i @anthropic-ai/sdk`가 필요하고(저장소 의존성 아님), 인증은 SDK 기본(ANTHROPIC_API_KEY 등)을 따른다.
//   모델은 CG_MODEL(기본 claude-opus-5-5). 응답은 형식(질문 1개, 답 3개, 각 40자 이내)을 검사해 출력한다. 이유 후보의 품질 보장은 아니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const inputPath = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!inputPath) { console.error('사용: node tools/expected-answers/generate.mjs <input.json> [--ontology path]'); process.exit(2); }
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (!input.behavior) throw new Error('input.behavior(행동 문장)가 필요합니다');

export function retrieve(terms, ontology, k = 5) {
  const words = terms.flatMap((t) => String(t).split(/[\s,.·'"()]+/)).filter((w) => w.length >= 2);
  return ontology.terms
    .map((t) => ({ t, s: words.filter((w) => `${t.label} ${t.definition ?? ''}`.includes(w)).length }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k)
    .map(({ t }) => ({ id: t.id, label: t.label, definition: t.definition, status: t.status }));
}

export function buildPrompt({ behavior, items, context }) {
  const tpl = fs.readFileSync(path.join(HERE, 'prompt.md'), 'utf8');
  const it = items.length ? items.map((x) => `- ${x.label} (${x.id}${x.status ? `, ${x.status}` : ''}): ${x.definition ?? ''}`).join('\n') : '- (조회 결과 없음)';
  return tpl.replace('{{behavior}}', behavior).replace('{{ontology_items}}', it).replace('{{context}}', context?.trim() || '(없음)');
}

export function validate(out) {
  const errs = [];
  if (typeof out?.question !== 'string' || !out.question.trim()) errs.push('question 없음');
  const a = out?.expected_answers;
  if (!Array.isArray(a) || a.length !== 3) errs.push('expected_answers는 3개여야 함');
  else a.forEach((x, i) => { const t = typeof x === 'string' ? x : x?.text; if (!t) errs.push(`답 ${i + 1} 비어 있음`); else if ([...t].length > 40) errs.push(`답 ${i + 1}이 40자 초과(${[...t].length}자)`); });
  return errs;
}

const ontology = JSON.parse(fs.readFileSync(opt('ontology', path.join(ROOT, 'data', 'seed', 'ontology.json')), 'utf8'));
const items = input.ontology_items ?? retrieve(input.ontology_query_terms ?? [input.behavior], ontology);
const prompt = buildPrompt({ behavior: input.behavior, items, context: input.context });

if (process.env.CG_LLM !== '1') {
  console.log(prompt);
  process.exit(0);
}

let Anthropic;
try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); } catch {
  console.error('CG_LLM=1에는 @anthropic-ai/sdk가 필요합니다: npm i @anthropic-ai/sdk'); process.exit(2);
}
const client = new Anthropic();
const res = await client.messages.create({
  model: process.env.CG_MODEL ?? 'claude-opus-5-5',
  max_tokens: 2000,
  output_config: { effort: 'low' },
  messages: [{ role: 'user', content: prompt }],
});
if (res.stop_reason === 'refusal') { console.error('모델이 거절했습니다:', res.stop_details?.category ?? ''); process.exit(1); }
const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
let out;
try { out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { console.error('JSON 파싱 실패:\n' + text); process.exit(1); }
const errs = validate(out);
console.log(JSON.stringify({ behavior: input.behavior, ontology_items: items.map((x) => x.id), ...out, choices_shown: ['(예상 답 3개)', '모두 틀림', '자유 입력'], format_errors: errs }, null, 1));
if (errs.length) process.exit(1);
