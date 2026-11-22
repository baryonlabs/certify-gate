import { test, expect } from '@playwright/test';

const shot = (page, name) => page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: true });

test('쟁점 항목: 대조 전 서명 비활성 → 대조·쟁점 처리 후 활성 → 인증 기록 생성', async ({ page, request }) => {
  await page.goto('/certify.html?id=autonomy');
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  const sign = page.locator('[data-act=approve]');
  await expect(sign).toBeDisabled();
  await shot(page, '01-gate-before-check');

  const n = await page.locator('[data-sentence]').count();
  expect(n).toBe(2);
  // 보기 전에는 체크박스 비활성
  await expect(page.locator('[data-act=check-0]')).toBeDisabled();
  for (let i = 0; i < n; i++) {
    await page.click(`[data-act=view-${i}]`);
    await expect(page.locator('.ss.on')).toHaveCount(1);
    await page.check(`[data-act=check-${i}]`);
  }
  await expect(page.locator('[data-step=check]')).toContainText(`${n}/${n}`);
  // 쟁점 미처리 → 여전히 비활성
  await expect(sign).toBeDisabled();
  await shot(page, '02-checked-contest-pending');

  await page.check('[data-act=interp-i2]');
  await page.click('[data-act=contest-submit]');
  await expect(page.locator('[data-step=contest]')).toContainText('완료');
  await expect(sign).toBeEnabled();
  await shot(page, '03-gate-open');

  await sign.click();
  await expect(page.locator('[data-region=done]')).toContainText('승인(인증)');
  await expect(page.locator('[data-region=done] [data-status=certified]')).toBeVisible();
  await shot(page, '04-certified');

  const log = await (await request.get('/api/log')).json();
  const rec = log.find((r) => r.item_id === 'autonomy' && r.decision === 'approve');
  expect(rec).toBeTruthy();
  expect(rec.actor).toEqual({ name: '저자', role: 'human' });
  expect(rec.checked_sentences.map((c) => c.idx)).toEqual([0, 1]);
  expect(rec.contest.choice).toBe('i2');
  expect(rec.contest.interpretations).toHaveLength(2);
  expect(rec.duration_ms).toBeGreaterThan(0);
  const exp = await (await request.get('/api/export')).json();
  expect(exp.terms.find((t) => t.id === 'autonomy').status).toBe('certified');
});

test('15% 초안 vs 14% 출판본: 불일치 강조, 사유 없는 보류 거부, 보류 시 초안 복귀', async ({ page, request }) => {
  await page.goto('/certify.html?id=skill_compression');
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  await expect(page.locator('[data-sentence="0"] [data-flag=edition]')).toContainText('15');
  await expect(page.locator('[data-sentence="0"]')).toHaveClass(/flagged/);
  await page.click('[data-act=view-0]');
  await expect(page.locator('.ss.on')).toHaveCount(1);
  await expect(page.locator('[data-act=check-0]')).toBeEnabled();
  await shot(page, '05-edition-mismatch');
  await page.click('[data-act=hold]');
  await expect(page.locator('[data-region=error]')).toContainText('사유');
  await page.fill('[data-act=reason]', 'QJE 2025 출판본 원문은 14%. 초안 15%는 워킹페이퍼 판본 수치');
  await page.click('[data-act=hold]');
  await expect(page.locator('[data-region=done] [data-status=draft]')).toBeVisible();
  await shot(page, '06-hold-to-draft');
  const it = await (await request.get('/api/items/skill_compression')).json();
  expect(it.status).toBe('draft');
});

test('클라이언트에서 버튼 활성화를 조작해도 서버가 거부', async ({ page }) => {
  await page.goto('/certify.html?id=gettier_problem');
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  await page.evaluate(() => { document.querySelector('[data-act=approve]').disabled = false; });
  await page.click('[data-act=approve]');
  await expect(page.locator('[data-region=error]')).toContainText('미완료');
  await expect(page.locator('[data-region=done]')).toBeHidden();
});

test('항목 목록 화면', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('table.list tbody tr')).not.toHaveCount(0);
  await shot(page, '00-item-list');
});
