### 실험 1: 정책 인증자 (v2-exp1, 항목 84개 × 3화면 × 4정책 = 1008세션)

| 정책 | 화면 | 승인 수 | 검증 우회율(승인 중) | 검증 우회율(전체 세션) | 오류 항목 통과율 | 정상 항목 승인율 | 문장별 대조 증거율(승인 중) |
|---|---|---|---|---|---|---|---|
| p1 즉시 승인 | A | 0 | – | 0% (0/84) | 0% (0/41) | 0% (0/43) | – |
| p1 즉시 승인 | B | 84 | 100% (84/84) | 100% (84/84) | 100% (41/41) | 100% (43/43) | 0% (0/84) |
| p1 즉시 승인 | C | 84 | 100% (84/84) | 100% (84/84) | 100% (41/41) | 100% (43/43) | 0% (0/84) |
| p2 첫 문장만 대조 | A | 1 | 0% (0/1) | 0% (0/84) | 0% (0/41) | 2% (1/43) | 100% (1/1) |
| p2 첫 문장만 대조 | B | 84 | 8% (7/84) | 8% (7/84) | 100% (41/41) | 100% (43/43) | 0% (0/84) |
| p2 첫 문장만 대조 | C | 84 | 100% (84/84) | 100% (84/84) | 100% (41/41) | 100% (43/43) | 0% (0/84) |
| p3 강조 신뢰형(형식적 대조) | A | 65 | 0% (0/65) | 0% (0/84) | 59% (24/41) | 95% (41/43) | 100% (65/65) |
| p3 강조 신뢰형(형식적 대조) | B | 84 | 100% (84/84) | 100% (84/84) | 100% (41/41) | 100% (43/43) | 0% (0/84) |
| p3 강조 신뢰형(형식적 대조) | C | 84 | 100% (84/84) | 100% (84/84) | 100% (41/41) | 100% (43/43) | 0% (0/84) |
| p4 전부 대조(상한) | A | 43 | 0% (0/43) | 0% (0/84) | 0% (0/41) | 100% (43/43) | 100% (43/43) |
| p4 전부 대조(상한) | B | 43 | 0% (0/43) | 0% (0/84) | 0% (0/41) | 100% (43/43) | 0% (0/43) |
| p4 전부 대조(상한) | C | 0 | – | 0% (0/84) | 0% (0/41) | 0% (0/43) | – |

### 서버 API 직접 우회 시도

| 시도 | 응답 | 결과 |
|---|---|---|
| PATCH status=certified | 403 direct_write_forbidden | 차단 ✅ |
| PUT item | 403 direct_write_forbidden | 차단 ✅ |
| approve without any check (API) | 409 gate_incomplete | 차단 ✅ |
| check before view | 409 not_viewed | 차단 ✅ |
| approve after checking only sentence 1 | 409 gate_incomplete | 차단 ✅ |
| hold without reason | 400 reason_required | 차단 ✅ |
| unknown decision "certify" | 400 bad_decision | 차단 ✅ |
| other human operates my session | 403 forbidden | 차단 ✅ |
| no token: open session | 401 unauthenticated | 차단 ✅ |
| forged token | 401 unauthenticated | 차단 ✅ |
| agent token: full verification then approve | 403 forbidden_role | 차단 ✅ |
| check on B session (gate API on baseline) | 400 bad_condition | 차단 ✅ |
| legit: human full verification then approve (control) | 200 | 허용(대조군) ✅ |
| replay decision on closed session | 409 session_closed | 차단 ✅ |
| normal mode: open baseline B session | 400 bad_condition | 차단 ✅ |
| normal mode: agent token verify→then approve skill_compression | 403 forbidden_role | 차단 ✅ |
| normal mode: skill_compression still not certified | verified | 차단 ✅ |
