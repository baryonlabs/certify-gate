// 지식 항목 상태 모델 (논문 그림: draft → verified → certified)
// - verified: 에이전트가 1차 출처와 일치를 확인했을 때 부여 가능
// - certified: 사람(human 역할)만 부여, 원문 대조·쟁점 검토 완료가 전제
// - hold/reject: 사유 필수, 항목은 draft로 되돌아감
// - [쟁점]: 두 해석을 모두 보존(interpretations), 인증 시 선택만 기록

export const STATUS = Object.freeze({ DRAFT: 'draft', VERIFIED: 'verified', CERTIFIED: 'certified' });
export const DECISIONS = Object.freeze(['approve', 'hold', 'reject']);
export const ROLES = Object.freeze({ HUMAN: 'human', AGENT: 'agent' });
export const MIN_REASON_LEN = 5;

export class TransitionError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 쟁점 항목인가: 해석이 2개 이상이거나 정의가 [쟁점]으로 시작 */
export function isContested(item) {
  return (item.interpretations?.length ?? 0) >= 2 || /^\s*\[쟁점\]/.test(item.definition ?? '');
}

/**
 * 게이트 충족 여부. session = { viewed:Set|array, checked:Set|array, contest:{choice, reason}|null }
 * 반환: { ok, missing: [...] }
 */
export function gateStatus(item, session) {
  const n = item.sentences?.length ?? 0;
  const checked = new Set(session?.checked ?? []);
  const missing = [];
  for (let i = 0; i < n; i++) if (!checked.has(i)) missing.push(`sentence:${i}`);
  if (isContested(item)) {
    const c = session?.contest;
    const resolved = c && (c.choice != null || (c.reason ?? '').trim().length >= MIN_REASON_LEN);
    if (!resolved) missing.push('contest');
  }
  return { ok: missing.length === 0, missing };
}

/** 에이전트의 1차 확인: draft → verified. 사람/에이전트 모두 가능하지만 certified로는 못 간다. */
export function verify(item, actor) {
  assertActor(actor);
  if (item.status !== STATUS.DRAFT) {
    throw new TransitionError('bad_state', `verified 전이는 draft에서만 가능 (현재 ${item.status})`);
  }
  return { ...item, status: STATUS.VERIFIED, verified_by: actor.name };
}

/**
 * 사람의 결정. 순수 함수: 새 item과 로그 레코드 일부를 반환.
 * decision: approve | hold | reject
 */
export function decide(item, actor, { decision, reason = '', session }) {
  assertActor(actor);
  if (!DECISIONS.includes(decision)) {
    throw new TransitionError('bad_decision', `알 수 없는 결정: ${decision}`, 400);
  }
  if (actor.role !== ROLES.HUMAN) {
    // 에이전트 역할 토큰은 인증(승인)·보류·거부 어떤 사람 결정도 내릴 수 없다
    throw new TransitionError('forbidden_role', '사람(human) 역할만 인증 결정을 내릴 수 있습니다', 403);
  }
  if (item.status === STATUS.CERTIFIED) {
    throw new TransitionError('already_certified', '이미 인증된 항목입니다');
  }
  const r = (reason ?? '').trim();
  if (decision === 'approve') {
    const g = gateStatus(item, session);
    if (!g.ok) {
      throw new TransitionError('gate_incomplete', `원문 대조/쟁점 검토 미완료: ${g.missing.join(', ')}`);
    }
    const next = { ...item, status: STATUS.CERTIFIED };
    if (isContested(item)) {
      // 두 해석은 그대로 보존, 선택만 기록
      next.interpretations = item.interpretations;
      next.resolution = { choice: session.contest.choice ?? null, reason: session.contest.reason ?? '' };
    }
    return next;
  }
  if (r.length < MIN_REASON_LEN) {
    throw new TransitionError('reason_required', `보류/거부는 사유가 필요합니다(${MIN_REASON_LEN}자 이상)`, 400);
  }
  // 보류·거부 → 초안으로 복귀 (쟁점 해석은 그대로 보존)
  return { ...item, status: STATUS.DRAFT, last_decision: { decision, reason: r } };
}

/** 의사결정에 쓸 수 있는 항목: 인증된 것만 */
export function decisionUsable(items) {
  return items.filter((t) => t.status === STATUS.CERTIFIED);
}

function assertActor(actor) {
  if (!actor || !actor.name || !Object.values(ROLES).includes(actor.role)) {
    throw new TransitionError('unauthenticated', '인증되지 않은 요청', 401);
  }
}
