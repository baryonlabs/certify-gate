# 예상 답 생성기 (논문 3장 ④)

행동-지식 간극마다 **이유를 묻는 질문 1개**와 **서로 다른 관점(원칙·조건·기대 결과)의 예상 답 3개(각 40자 이내)**를 만드는 프롬프트 템플릿과 작은 스크립트다. 화면은 예상 답 아래에 **'모두 틀림'과 자유 입력 칸**을 함께 둔다.

- 입력: ① 행동 문장(누가, 무엇을, 어떤 상황에서) ② ②단계에서 조회한 온톨로지 항목 ③ 그 행동 직전의 대화 맥락
- `prompt.md`: 템플릿(`{{behavior}}`, `{{ontology_items}}`, `{{context}}`)
- `generate.mjs`: 입력 JSON → 온톨로지 조회(단어 일치, 최대 5개, 또는 입력에 직접 지정) → 프롬프트 출력. 의존성 없음.
- `example.json`: 논문 표 3 첫 행 사례(인증은 맡기지 않고 자동 라운드는 승인)

```bash
node tools/expected-answers/generate.mjs tools/expected-answers/example.json          # 프롬프트만 출력(기본)
npm i @anthropic-ai/sdk && CG_LLM=1 node tools/expected-answers/generate.mjs tools/expected-answers/example.json   # 선택: Claude 호출
```

- LLM 호출은 `CG_LLM=1`일 때만 한다. 인증은 Anthropic SDK 기본 방식(`ANTHROPIC_API_KEY` 등), 모델은 `CG_MODEL`(기본 `claude-opus-5-5`). 결과는 형식(답 3개, 40자 이내)만 검사한다.
- 파일럿에서 쓴 실제 질문·예상 답은 [`eval/tacit-pilot/items.json`](../../eval/tacit-pilot/items.json)에 있다(당시 연구 에이전트가 같은 지시로 대화 안에서 생성, 이 스크립트로 생성한 것은 아님).
- 간극 판정(③)은 포함하지 않는다. 파일럿에서도 판정은 수작업이었다.
