// 속성 기반 테스트: 무작위 항목 × 무작위 조작 순서(보기·체크·해제·쟁점·결정, 사람/에이전트/타인 토큰)
// 불변식:
//  (I1) certified ⇔ 사람 역할 ∧ (그 시점에) 모든 문장 '보기 후 체크' ∧ 쟁점 해결
//  (I2) 보류·거부 성공 ⇒ 사유 ≥ 5자 ∧ 상태 draft
//  (I3) 기준 화면(B) 결정은 상태를 바꾸지 않음
//  (I4) 승인 기록에는 모든 문장의 viewed_at ≤ checked_at 증거가 있음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server.js';

const RUNS = Number(process.env.PROP_RUNS ?? 600);
let seed = Number(process.env.PROP_SEED ?? 424242);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

function randomItems(n) {
  const words = ['protein', 'cohort', 'risk', 'increase', 'mice', 'patients', 'dose', 'trial', 'effect', 'level'];
  return Array.from({ length: n }, (_, k) => {
    const ns = 1 + ri(4);
    const sentences = Array.from({ length: ns }, () => `The ${pick(words)} ${pick(words)} was ${ri(100)} percent in ${pick(words)}.`);
    const contested = rnd() < 0.25;
    return {
      id: `P${k}`, label: `prop ${k}`, definition: (contested ? '[쟁점] ' : '') + sentences.join(' '), status: pick(['draft', 'verified']),
      sentences, sources: [{ key: 's', label: 'src', text: sentences.join(' ') + ' Extra context sentence here.' }],
      interpretations: contested ? [{ id: 'i1', text: 'A' }, { id: 'i2', text: 'B' }] : undefined,
    };
  });
}

test(`무작위 ${RUNS}회: 게이트 불변식`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prop-'));
  const items = randomItems(40);
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items }));
  const { server } = createApp({ bench: true, itemsFile: path.join(dir, 'items.json'), dataDir: dir, logFile: path.join(dir, 'log.jsonl') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, tok) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const TOK = { human: 'human-dev-token', agent: 'agent-dev-token', other: 'human2-dev-token' };
  const stats = { certified: 0, approve_rejected: 0, held: 0, b_decisions: 0, ops: 0 };
  try {
    for (let run = 0; run < RUNS; run++) {
      const it = pick(items);
      const cond = rnd() < 0.2 ? 'B' : 'A';
      const owner = rnd() < 0.2 ? 'agent' : 'human';
      const sid = (await call('POST', '/api/sessions', { item_id: it.id, condition: cond }, TOK[owner])).body.session_id;
      assert.ok(sid);
      const viewed = new Set(), checked = new Set();
      let contest = null, closed = false;
      const steps = 1 + ri(14);
      // 절반가량은 '성실한' 앞부분(문장 일부/전부 보기→체크, 가끔 쟁점)을 무작위 순서로 섞어 넣어 모든 분기를 덮는다
      const script = [];
      if (rnd() < 0.5) {
        const order = it.sentences.map((_, i) => i).sort(() => rnd() - 0.5).filter(() => rnd() < 0.9);
        for (const i of order) script.push(['view', i], ['check', i]);
        if (rnd() < 0.8) script.push(['contest', null]);
      }
      for (let k = 0; k < steps + script.length && !closed; k++) {
        stats.ops++;
        const scripted = script[k];
        const who = scripted ? owner : rnd() < 0.85 ? owner : pick(['human', 'agent', 'other']);
        const op = scripted ? scripted[0] : pick(['view', 'view', 'check', 'check', 'uncheck', 'contest', 'decide', 'decide']);
        const idx = scripted && scripted[1] != null ? scripted[1] : ri(it.sentences.length + 1) - (rnd() < 0.1 ? 1 : 0); // 가끔 범위 밖
        if (op === 'view') {
          const r = await call('POST', `/api/sessions/${sid}/view`, { idx }, TOK[who]);
          if (r.status === 200) { assert.equal(who, owner); viewed.add(idx); }
        } else if (op === 'check' || op === 'uncheck') {
          const r = await call('POST', `/api/sessions/${sid}/check`, { idx, checked: op === 'check' }, TOK[who]);
          if (r.status === 200) {
            assert.equal(cond, 'A'); assert.equal(who, owner); assert.ok(viewed.has(idx), '보기 전 체크가 성공하면 안 됨');
            op === 'check' ? checked.add(idx) : checked.delete(idx);
          }
        } else if (op === 'contest') {
          const body = rnd() < 0.5 ? { choice: pick(['i1', 'i2', 'i9', null]) } : { choice: null, reason: pick(['', '짧음', '두 해석 모두 근거 있음']) };
          const r = await call('POST', `/api/sessions/${sid}/contest`, body, TOK[who]);
          if (r.status === 200) contest = body;
        } else {
          const decision = cond === 'B' ? pick(['approve', 'skip', 'hold']) : pick(['approve', 'approve', 'hold', 'reject', 'certify']);
          const reason = pick(['', 'abc', '원문 수치와 다름', '사유가 충분히 긴 보류']);
          const r = await call('POST', `/api/sessions/${sid}/decision`, { decision, reason }, TOK[who]);
          const contested = (it.interpretations?.length ?? 0) >= 2;
          const contestOk = !contested || !!(contest && (contest.choice === 'i1' || contest.choice === 'i2' || (contest.reason ?? '').trim().length >= 5));
          const gateOk = it.sentences.every((_, i) => checked.has(i)) && contestOk;
          if (cond === 'B') {
            const ok = who === owner && owner === 'human' && ['approve', 'skip'].includes(decision);
            assert.equal(r.status === 200, ok, `B 결정 기대 ${ok}, 실제 ${r.status}`);
            if (ok) { assert.equal(r.body.to_status, it.status, 'I3'); stats.b_decisions++; closed = true; }
          } else if (decision === 'approve') {
            const ok = who === owner && owner === 'human' && gateOk;
            assert.equal(r.status === 200, ok, `I1 approve 기대 ${ok}, 실제 ${r.status} ${r.body.error}`);
            if (ok) { assert.equal(r.body.to_status, 'certified'); stats.certified++; closed = true; } else stats.approve_rejected++;
          } else if (decision === 'hold' || decision === 'reject') {
            const ok = who === owner && owner === 'human' && reason.trim().length >= 5;
            assert.equal(r.status === 200, ok, `I2 ${decision} 기대 ${ok}, 실제 ${r.status} ${r.body.error}`);
            if (ok) { assert.equal(r.body.to_status, 'draft'); stats.held++; closed = true; }
          } else {
            assert.notEqual(r.status, 200, '알 수 없는 결정은 거부');
          }
        }
      }
    }
    // I4: 승인 기록의 증거
    const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const rec of log.filter((r) => r.condition === 'A' && r.decision === 'approve')) {
      const it = items.find((x) => x.id === rec.item_id);
      assert.equal(rec.actor.role, 'human');
      assert.equal(rec.checked_sentences.length, it.sentences.length);
      for (const c of rec.checked_sentences) assert.ok(c.viewed_at && c.viewed_at <= c.checked_at, 'I4');
    }
    assert.ok(stats.certified > 0 && stats.approve_rejected > 0 && stats.held > 0, `생성기가 모든 분기를 덮어야 함 ${JSON.stringify(stats)}`);
    console.log(`property stats ${JSON.stringify(stats)}`);
  } finally {
    server.close();
  }
});
