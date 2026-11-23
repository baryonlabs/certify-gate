import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, verify, gateStatus, decisionUsable, TransitionError } from '../../src/state.js';

const human = { name: '저자', role: 'human' };
const agent = { name: 'bot-2', role: 'agent' };
const item = (o = {}) => ({ id: 'x', label: 'X', definition: '문장 하나. 문장 둘.', status: 'verified', sentences: ['문장 하나.', '문장 둘.'], sources: [], ...o });
const contested = () => item({ definition: '[쟁점] A vs B', sentences: ['A', 'B'], status: 'draft', interpretations: [{ id: 'i1', text: 'A' }, { id: 'i2', text: 'B' }] });
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof TransitionError); return e.code; } assert.fail('예외가 나야 함'); };

test('사람만 certified로 전이할 수 있다', () => {
  const s = { checked: [0, 1] };
  assert.equal(decide(item(), human, { decision: 'approve', session: s }).status, 'certified');
  assert.equal(code(() => decide(item(), agent, { decision: 'approve', session: s })), 'forbidden_role');
});

test('에이전트는 draft→verified만 가능', () => {
  assert.equal(verify(item({ status: 'draft' }), agent).status, 'verified');
  assert.equal(code(() => verify(item({ status: 'verified' }), agent)), 'bad_state');
});

test('원문 대조 미완료 시 서명(승인) 거부', () => {
  assert.equal(code(() => decide(item(), human, { decision: 'approve', session: { checked: [0] } })), 'gate_incomplete');
  assert.equal(code(() => decide(item(), human, { decision: 'approve', session: {} })), 'gate_incomplete');
  assert.deepEqual(gateStatus(item(), { checked: [0] }).missing, ['sentence:1']);
});

test('보류/거부는 사유 필수이며 draft로 복귀', () => {
  for (const d of ['hold', 'reject']) {
    assert.equal(code(() => decide(item(), human, { decision: d, reason: '' })), 'reason_required');
    assert.equal(code(() => decide(item(), human, { decision: d, reason: '짧음' })), 'reason_required');
    const n = decide(item(), human, { decision: d, reason: '출판본은 15%임' });
    assert.equal(n.status, 'draft');
    assert.equal(n.last_decision.decision, d);
  }
});

test('쟁점: 해석 선택 또는 보류 사유 없이는 승인 불가, 승인 후에도 두 해석 보존', () => {
  const c = contested();
  assert.equal(code(() => decide(c, human, { decision: 'approve', session: { checked: [0, 1] } })), 'gate_incomplete');
  assert.equal(code(() => decide(c, human, { decision: 'approve', session: { checked: [0, 1], contest: { choice: null, reason: '' } } })), 'gate_incomplete');
  const n = decide(c, human, { decision: 'approve', session: { checked: [0, 1], contest: { choice: 'i2' } } });
  assert.equal(n.status, 'certified');
  assert.equal(n.interpretations.length, 2);
  assert.equal(n.resolution.choice, 'i2');
  const h = decide(c, human, { decision: 'hold', reason: '두 해석 모두 근거 있음' });
  assert.equal(h.status, 'draft');
  assert.equal(h.interpretations.length, 2);
});

test('이미 인증된 항목은 재결정 불가, 의사결정엔 인증본만', () => {
  assert.equal(code(() => decide(item({ status: 'certified' }), human, { decision: 'hold', reason: '다시 보기' })), 'already_certified');
  const xs = [item({ id: 'a', status: 'certified' }), item({ id: 'b', status: 'verified' }), item({ id: 'c', status: 'draft' })];
  assert.deepEqual(decisionUsable(xs).map((x) => x.id), ['a']);
});

test('알 수 없는 결정·미인증 actor 거부', () => {
  assert.equal(code(() => decide(item(), human, { decision: 'certify' })), 'bad_decision');
  assert.equal(code(() => decide(item(), null, { decision: 'approve' })), 'unauthenticated');
});
