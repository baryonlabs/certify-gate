#!/usr/bin/env python3
"""13문항 제3자 평가 분석(논문 5장, 각주 2). 표준 라이브러리만 사용.
사용: python3 eval/13q/analyze.py
조건: (가) baseline=검색 끔, (나) rag=원문 18건 검색, (다) rag_small=원문 300자 조각 검색, (라) loop=루프 온톨로지 검색.
채점: 조건을 가린 LLM 채점자. judges/judge_{,rag_,small_}{A,B}.json = Claude 계열 2개, judges/judge_C.json = GPT 계열(교차 채점, 52개 전체).
주 라벨 = Claude 계열 두 채점자의 합의(불일치 시 목록 출력). 재판정(rejudge.json)을 덮어쓴 뒤 '실질적 답'(correct/partial)을 센다.
출력: per_question_table.json(재판정 반영), summary.json
"""
import json, os, collections
from math import comb

H = os.path.dirname(os.path.abspath(__file__))
L = lambda *p: json.load(open(os.path.join(H, *p)))
ans = {x['blind_id']: x for f in ('answers.json', 'answers_rag.json', 'answers_rag_small.json') for x in L(f)}
JA, JB = {}, {}
for a, b in (('judge_A', 'judge_B'), ('judge_rag_A', 'judge_rag_B'), ('judge_small_A', 'judge_small_B')):
    JA.update({x['blind_id']: x for x in L('judges', a + '.json')})
    JB.update({x['blind_id']: x for x in L('judges', b + '.json')})
JC = {x['blind_id']: x for x in L('judges', 'judge_C.json')}
LABS = ['correct', 'partial', 'refusal', 'incorrect']
ids = sorted(ans)

def kappa(a, b):
    n = len(a); po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = collections.Counter(a), collections.Counter(b)
    pe = sum(ca[l] * cb[l] for l in LABS) / n / n
    return (po - pe) / (1 - pe) if pe < 1 else 1.0, po

kAB = kappa([JA[i]['label'] for i in ids], [JB[i]['label'] for i in ids])
kAC = kappa([JA[i]['label'] for i in ids], [JC[i]['label'] for i in ids])
kBC = kappa([JB[i]['label'] for i in ids], [JC[i]['label'] for i in ids])
dis = [(i, ans[i]['id'], ans[i]['cond'], JA[i]['label'], JB[i]['label']) for i in ids if JA[i]['label'] != JB[i]['label']]
disC = [(i, ans[i]['id'], ans[i]['cond'], JA[i]['label'], JC[i]['label']) for i in ids if JA[i]['label'] != JC[i]['label']]

lab0 = {i: {'label': JA[i]['label'], 'fabrication': JA[i]['fabrication'] and JB[i]['fabrication']} for i in ids}
lab = {i: dict(v) for i, v in lab0.items()}
for o in L('rejudge.json')['overrides']:
    assert lab[o['blind_id']]['label'] == o['from']['label'], o
    lab[o['blind_id']] = dict(o['to'])

CONDS = [('baseline', '(가) 검색 끔'), ('rag', '(나) 원문 18건 검색'), ('rag_small', '(다) 원문 300자 조각 검색'), ('loop', '(라) 루프 온톨로지 검색')]
SYM = {'correct': '○', 'partial': '△', 'incorrect': '×', 'refusal': '-'}
qs = L('questions.json')
by = {(ans[i]['id'], ans[i]['cond']): i for i in ids}
subst = lambda L_, q, c: L_[by[(q, c)]]['label'] in ('correct', 'partial')

def table(L_):
    return [['문항'] + [k for _, k in CONDS]] + [[q['id']] + [SYM[L_[by[(q['id'], c)]]['label']] for c, _ in CONDS] for q in qs]

def counts(L_):
    return {c: sum(subst(L_, q['id'], c) for q in qs) for c, _ in CONDS}

def mcnemar(L_, a='loop', b='rag'):
    x = sum(subst(L_, q['id'], a) and not subst(L_, q['id'], b) for q in qs)
    y = sum(subst(L_, q['id'], b) and not subst(L_, q['id'], a) for q in qs)
    n = x + y
    p = min(1.0, 2 * sum(comb(n, k) for k in range(0, min(x, y) + 1)) / 2 ** n) if n else 1.0
    return {'only_' + a: x, 'only_' + b: y, 'p_exact_two_sided': p}

res = {
    'label': '13문항 제3자 평가(LLM 채점, 소규모)',
    'judge_agreement': {'claudeA_vs_claudeB': {'kappa': kAB[0], 'agree': kAB[1]}, 'claudeA_vs_gptC': {'kappa': kAC[0], 'agree': kAC[1]}, 'claudeB_vs_gptC': {'kappa': kBC[0], 'agree': kBC[1]}, 'A_B_disagreements': dis, 'A_C_disagreements': disC},
    'initial': {'substantive_counts': counts(lab0), 'mcnemar_loop_vs_rag': mcnemar(lab0), 'fabrication': {c: sum(lab0[by[(q['id'], c)]]['fabrication'] for q in qs) for c, _ in CONDS}},
    'rejudged': {'substantive_counts': counts(lab), 'mcnemar_loop_vs_rag': mcnemar(lab), 'fabrication': {c: sum(lab[by[(q['id'], c)]]['fabrication'] for q in qs) for c, _ in CONDS}},
    'overrides': L('rejudge.json')['overrides'],
}
json.dump(res, open(os.path.join(H, 'summary.json'), 'w'), ensure_ascii=False, indent=1)
json.dump(table(lab), open(os.path.join(H, 'per_question_table.json'), 'w'), ensure_ascii=False)

print('채점자 일치(52개): Claude A–B κ=%.2f, Claude A–GPT C κ=%.2f (일치 %.0f%%), Claude B–GPT C κ=%.2f' % (kAB[0], kAC[0], 100 * kAC[1], kBC[0]))
for d in disC: print('  A≠C', d)
for name, L_ in (('초기 판정', lab0), ('재판정 반영(Q01 (라) 오답→부분 정답)', lab)):
    c, m = counts(L_), mcnemar(L_)
    print(f'\n[{name}] 실질적 답(정답·부분 정답) 수: ' + ', '.join(f'{k} {c[k2]}' for k2, k in CONDS))
    print(f"  맥니마 (라) vs (나): (라)만 {m['only_loop']}, (나)만 {m['only_rag']}, 정확 p = {m['p_exact_two_sided']:.3f}")
print('\n| ' + ' | '.join(table(lab)[0]) + ' |\n|' + '---|' * len(CONDS + [0]))
for r in table(lab)[1:]: print('| ' + ' | '.join(r) + ' |')
print('○ 정답, △ 부분 정답, × 오답, - 답 못함(거절)')
