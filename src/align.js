// 초안 문장 ↔ 1차 출처 문장 정렬과 불일치 강조(숫자·연도·판본·인과/단정 표현·근거 약함)
// 의도적으로 단순한 규칙 기반이다. 사람(인증자)의 대조를 돕는 '주의 표시'일 뿐 판정기가 아니다.

const NUM_RE = /(?<![A-Za-zα-ωΑ-Ω*\d]|[A-Za-z]\d*\.)(\d[\d,]*(?:[.·]\d+)?)(?![A-Za-zα-ωΑ-Ω])/g;
const CAUSAL_RE = /\b(cause[sd]?|causing|guarantee[sd]?|always|eliminat\w*|prove[sd]?|all|every|completely)\b|유발|때문|반드시|항상|모든|입증|보장|완전히/gi;
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'and', 'or', 'to', 'is', 'are', 'was', 'were', 'by', 'for', 'with', 'on', 'that', 'this', 'as', 'at', 'be', 'from', 'it', 'its', 'than']);

export function splitSentences(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。])\s+(?=[^\s\d)])|;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export function normNum(s) {
  return s.replace(/,/g, '').replace(/·/g, '.');
}

export function numbersIn(text) {
  const out = [];
  for (const m of (text ?? '').matchAll(NUM_RE)) {
    const n = normNum(m[1]).replace(/\.$/, '');
    if (n) out.push(n);
  }
  return out;
}

function tokens(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/[()[\]{}"'“”‘’,:;!?·]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[.]+$/, '').replace(/(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만)$/u, ''))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function overlap(a, b) {
  const tb = new Set(tokens(b));
  const ta = tokens(a);
  if (!ta.length) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  const na = numbersIn(a);
  const nb = new Set(numbersIn(b));
  let nhit = 0;
  for (const n of na) if (nb.has(n)) nhit++;
  return (hit + 3 * nhit) / (ta.length + 3 * na.length);
}

/**
 * item.sentences (string[]) 와 item.sources[{key,label,text}] 를 받아
 * 문장별 { idx, text, ref:{source, sentence, score}, flags:[{type, token, message}] } 를 만든다.
 */
export function analyze(item) {
  const srcSents = [];
  (item.sources ?? []).forEach((s, si) => {
    splitSentences(s.text ?? '').forEach((t, j) => srcSents.push({ source: si, sentence: j, text: t }));
  });
  const allSrc = srcSents.map((s) => s.text).join(' ');
  const srcNums = new Set(numbersIn(allSrc));
  const srcNumVals = [...srcNums].map(Number).filter((x) => !Number.isNaN(x));

  return (item.sentences ?? []).map((text, idx) => {
    let best = null;
    for (const s of srcSents) {
      const sc = overlap(text, s.text);
      if (!best || sc > best.score) best = { source: s.source, sentence: s.sentence, score: Math.round(sc * 100) / 100 };
    }
    const flags = [];
    if (!srcSents.length) {
      flags.push({ type: 'no_source', message: '원문 발췌 없음 — 원문 링크로 직접 확인 필요' });
    } else {
      for (const n of new Set(numbersIn(text))) {
        if (srcNums.has(n)) continue;
        const v = Number(n);
        const isYear = /^(1[5-9]|20)\d\d$/.test(n);
        const approx = !isYear && srcNumVals.some((x) => Math.trunc(x) === Math.trunc(v) && x !== v);
        if (approx) flags.push({ type: 'approx', token: n, message: `숫자 ${n}: 원문에는 근사값만 있음` });
        else flags.push({ type: isYear ? 'year' : 'number', token: n, message: `${isYear ? '연도' : '숫자'} ${n}: 원문에 없음` });
      }
      const aligned = best ? srcSents.find((s) => s.source === best.source && s.sentence === best.sentence)?.text ?? '' : '';
      const srcCausal = new Set([...allSrc.matchAll(CAUSAL_RE)].map((m) => m[0].toLowerCase()));
      for (const m of new Set([...text.matchAll(CAUSAL_RE)].map((x) => x[0].toLowerCase()))) {
        if (!srcCausal.has(m)) flags.push({ type: 'causal', token: m, message: `인과·단정 표현 "${m}": 원문 표현 확인` });
      }
      const hangul = (s) => /[가-힣]/.test(s) && !/[A-Za-z]{4,}.*[A-Za-z]{4,}.*[A-Za-z]{4,}/.test(s);
      if (best && best.score < 0.2 && aligned) {
        if (hangul(text) !== hangul(allSrc)) flags.push({ type: 'weak', message: '초안과 원문의 언어가 달라 자동 대응이 불확실 — 직접 대조 필요' });
        else flags.push({ type: 'weak', message: '원문에서 대응 문장을 찾기 어려움(근거 약함)' });
      }
    }
    // 판본 불일치: 같은 숫자가 일부 판본에만 있으면 표시
    const eds = (item.sources ?? []).filter((s) => s.edition && s.text);
    if (eds.length > 1) {
      for (const n of new Set(numbersIn(text))) {
        const has = eds.filter((s) => numbersIn(s.text).includes(n));
        if (has.length && has.length < eds.length) {
          const lacks = eds.filter((s) => !has.includes(s));
          flags.push({
            type: 'edition', token: n,
            message: `판본 불일치 ${n}: '${has.map((s) => s.edition).join(', ')}'에만 있고 '${lacks.map((s) => s.edition).join(', ')}'에는 없음`,
          });
        }
      }
    }
    return { idx, text, ref: best, flags };
  });
}

export function sourceSentences(item) {
  return (item.sources ?? []).map((s) => splitSentences(s.text ?? ''));
}
