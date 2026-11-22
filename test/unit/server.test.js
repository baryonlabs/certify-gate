// 서버 측 강제: 클라이언트 우회로 certified 불가, 에이전트 토큰 금지, 로그 기록, 원본 불변
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/server.js';

const ORIG = '/Users/hongmartin/.orca/bots/bot-2/ontology/ontology.json';
let base, srv, dataDir, origHash;
const H = 'human-dev-token', A = 'agent-dev-token';
async function call(method, p, body, tok = H) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  if (fs.existsSync(ORIG)) origHash = hash(ORIG);
  ({ server: srv } = createApp({ dataDir }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

test('직접 상태 쓰기(PATCH) 거부', async () => {
  const r = await call('PATCH', '/api/items/skill_compression', { status: 'certified' });
  assert.equal(r.status, 403);
});

test('대조 없이 승인 → 409, 보기 전 체크 → 409', async () => {
  const { body: { session_id } } = await call('POST', '/api/sessions', { item_id: 'skill_compression' });
  assert.equal((await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'approve' })).status, 409);
  assert.equal((await call('POST', `/api/sessions/${session_id}/check`, { idx: 0 })).status, 409);
});

test('에이전트 토큰은 대조를 다 해도 certified 불가', async () => {
  const { body: { session_id } } = await call('POST', '/api/sessions', { item_id: 'gettier_problem' }, A);
  const it = (await call('GET', '/api/items/gettier_problem')).body;
  for (let i = 0; i < it.sentences.length; i++) {
    await call('POST', `/api/sessions/${session_id}/view`, { idx: i }, A);
    await call('POST', `/api/sessions/${session_id}/check`, { idx: i }, A);
  }
  const r = await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'approve' }, A);
  assert.equal(r.status, 403);
  assert.equal((await call('GET', '/api/items/gettier_problem')).body.status, 'verified');
});

test('토큰 없음 → 401, 남의 세션 → 403', async () => {
  assert.equal((await call('POST', '/api/sessions', { item_id: 'gettier_problem' }, null)).status, 401);
  const { body: { session_id } } = await call('POST', '/api/sessions', { item_id: 'gettier_problem' });
  assert.equal((await call('POST', `/api/sessions/${session_id}/view`, { idx: 0 }, 'human2-dev-token')).status, 403);
});

test('기준 화면(B/C) 세션은 일반 모드에서 열 수 없음', async () => {
  assert.equal((await call('POST', '/api/sessions', { item_id: 'gettier_problem', condition: 'B' })).status, 400);
});

test('사람이 대조 완료 후 승인 → certified, 로그·내보내기·의사결정 KB 반영', async () => {
  const it = (await call('GET', '/api/items/gettier_problem')).body;
  const { body: { session_id } } = await call('POST', '/api/sessions', { item_id: 'gettier_problem' });
  for (let i = 0; i < it.sentences.length; i++) {
    await call('POST', `/api/sessions/${session_id}/view`, { idx: i });
    await call('POST', `/api/sessions/${session_id}/check`, { idx: i });
  }
  const r = await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.body.to_status, 'certified');
  const log = (await call('GET', '/api/log')).body.find((x) => x.log_id === r.body.log_id);
  assert.equal(log.actor.name, '저자');
  assert.equal(log.checked_sentences.length, it.sentences.length);
  assert.ok(log.duration_ms >= 0 && log.started_at && log.decided_at);
  const exp = (await call('GET', '/api/export')).body;
  const t = exp.terms.find((x) => x.id === 'gettier_problem');
  assert.equal(t.status, 'certified');
  assert.equal(t.certification.by, '저자');
  assert.ok(Array.isArray(exp.relations) && Array.isArray(exp.questions));
  assert.ok((await call('GET', '/api/decision-kb')).body.some((x) => x.id === 'gettier_problem'));
  // 작업 복사본에 저장됨
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'ontology.json'), 'utf8')).terms.find((x) => x.id === 'gettier_problem').status, 'certified');
});

test('보류 → draft 복귀(사유 필수), 15% 사례', async () => {
  const { body: { session_id } } = await call('POST', '/api/sessions', { item_id: 'skill_compression' });
  assert.equal((await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'hold', reason: '' })).status, 400);
  const r = await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'hold', reason: 'QJE 출판본은 14%, 초안 15%는 워킹페이퍼 판본' });
  assert.equal(r.body.to_status, 'draft');
  assert.equal((await call('GET', '/api/items/skill_compression')).body.status, 'draft');
});

test('쟁점 항목: 해석 선택 후 인증, 두 해석 보존', async () => {
  const it = (await call('GET', '/api/items/autonomy')).body;
  assert.equal(it.contested, true);
  assert.equal(it.interpretations.length, 2);
  const { body: { session_id } } = await call('POST', '/api/sessions', { item_id: 'autonomy' });
  for (let i = 0; i < it.sentences.length; i++) {
    await call('POST', `/api/sessions/${session_id}/view`, { idx: i });
    await call('POST', `/api/sessions/${session_id}/check`, { idx: i });
  }
  assert.equal((await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'approve' })).status, 409);
  await call('POST', `/api/sessions/${session_id}/contest`, { choice: 'i2' });
  assert.equal((await call('POST', `/api/sessions/${session_id}/decision`, { decision: 'approve' })).status, 200);
  const t = (await call('GET', '/api/export')).body.terms.find((x) => x.id === 'autonomy');
  assert.equal(t.status, 'certified');
  assert.equal(t.interpretations.length, 2);
  assert.equal(t.resolution.choice, 'i2');
});

test('원본 ontology.json은 수정되지 않음', { skip: !fs.existsSync(ORIG) }, () => {
  assert.equal(hash(ORIG), origHash);
});
