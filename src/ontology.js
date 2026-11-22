// ontology.json 형식(terms / relations / questions) ↔ 인증 항목(item) 변환
import { splitSentences } from './align.js';

const CORE_FIELDS = new Set(['id', 'label', 'definition', 'status', 'sources', 'round']);

/** "[쟁점] A vs B" 또는 "[쟁점] X: ... . Y: ..." 형태를 두 해석으로 나눈다 */
export function parseInterpretations(definition) {
  if (!/^\s*\[쟁점\]/.test(definition ?? '')) return null;
  const body = definition.replace(/^\s*\[쟁점\]\s*/, '');
  let parts = body.split(/\s+vs\.?\s+/);
  if (parts.length < 2) parts = splitSentences(body);
  parts = parts.map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.map((text, i) => ({ id: `i${i + 1}`, text })) : null;
}

/**
 * term + 출처 저장소(sourcesDb: { sources: {key:{label,url,edition,text,kind}}, terms: {id:{interpretations}} })
 * → item
 */
export function termToItem(term, sourcesDb = {}) {
  const srcMap = sourcesDb.sources ?? {};
  const termOverride = sourcesDb.terms?.[term.id] ?? {};
  const sources = (term.sources ?? []).map((key) => {
    const s = srcMap[key] ?? {};
    return {
      key,
      url: s.url ?? (/^https?:/.test(key) ? key : null),
      label: s.label ?? key,
      edition: s.edition ?? null,
      kind: s.kind ?? (s.text ? 'excerpt' : 'link_only'),
      text: s.text ?? '',
    };
  });
  const interpretations = term.interpretations ?? termOverride.interpretations ?? parseInterpretations(term.definition);
  const sentences = interpretations?.length >= 2 ? interpretations.map((i) => i.text) : splitSentences(term.definition);
  const extra = {};
  for (const [k, v] of Object.entries(term)) if (!CORE_FIELDS.has(k)) extra[k] = v;
  return {
    ...extra,
    id: term.id,
    label: term.label,
    definition: term.definition,
    status: term.status ?? 'draft',
    round: term.round,
    sources,
    interpretations: interpretations ?? undefined,
    sentences,
  };
}

/** item → term (같은 ontology.json 형식, 인증 메타데이터는 추가 필드로) */
export function itemToTerm(item, originalTerm = {}) {
  const t = { ...originalTerm, id: item.id, label: item.label, definition: item.definition, status: item.status };
  t.sources = item.sources?.map((s) => s.key) ?? originalTerm.sources ?? [];
  if (item.round !== undefined) t.round = item.round;
  for (const k of ['interpretations', 'resolution', 'certification', 'last_decision', 'verified_by']) {
    if (item[k] !== undefined) t[k] = item[k];
  }
  return t;
}

export function validateOntology(o) {
  const errs = [];
  if (!o || typeof o !== 'object') errs.push('JSON 객체가 아님');
  else {
    if (!Array.isArray(o.terms)) errs.push('terms 배열 없음');
    else o.terms.forEach((t, i) => {
      if (!t.id) errs.push(`terms[${i}].id 없음`);
      if (typeof t.definition !== 'string') errs.push(`terms[${i}].definition 없음`);
    });
    if (o.relations && !Array.isArray(o.relations)) errs.push('relations는 배열이어야 함');
    if (o.questions && !Array.isArray(o.questions)) errs.push('questions는 배열이어야 함');
  }
  return errs;
}
