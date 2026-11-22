// SciFact 원본(data.tar.gz 압축 해제 디렉터리)에서 벤치에 쓰는 주장만 추출해 bench/data/scifact_subset.jsonl 로 저장.
// 사용: curl -LO https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz && tar xzf data.tar.gz
//       node bench/scifact-extract.mjs ./data
// 라이선스: claims = CC BY 4.0, corpus abstracts = ODC-By 1.0 (bench/data/SCIFACT_LICENSE.md)
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
if (!dir) { console.error('usage: node bench/scifact-extract.mjs <scifact data dir>'); process.exit(1); }
const WANT = { dev: [5, 50, 51, 53, 70, 100, 137, 148, 163, 208, 216, 217, 230, 274, 279, 298, 327, 380, 386, 513, 1185], train: [22, 564, 854, 919, 1148, 1297] };
const jl = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const corpus = new Map(jl('corpus.jsonl').map((d) => [d.doc_id, d]));
const out = [];
for (const [split, ids] of Object.entries(WANT)) {
  for (const c of jl(`claims_${split}.jsonl`)) {
    if (!ids.includes(c.id)) continue;
    const [doc, evs] = Object.entries(c.evidence)[0];
    const d = corpus.get(Number(doc));
    const sents = [...new Set(evs.flatMap((e) => e.sentences))].sort((a, b) => a - b);
    out.push({ split, claim_id: c.id, claim: c.claim, label: evs[0].label, doc_id: Number(doc), title: d.title, rationale: sents.map((s) => d.abstract[s].trim()).join(' ') });
  }
}
fs.writeFileSync(new URL('./data/scifact_subset.jsonl', import.meta.url), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`${out.length} claims`);
