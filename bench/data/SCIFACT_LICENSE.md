# SciFact 데이터 라이선스 / attribution

`scifact_subset.jsonl` 은 SciFact (Wadden et al., 2020, "Fact or Fiction: Verifying Scientific Claims", EMNLP) 에서 27개 주장을 추출한 것이다.
- 출처: https://github.com/allenai/scifact (release/latest/data.tar.gz)
- claims, evidence annotations: **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- abstracts (corpus.jsonl, S2ORC 기반): **ODC-By 1.0** — https://opendatacommons.org/licenses/by/1-0/

벤치마크에서는 일부 주장을 의도적으로 변형(숫자·연도·인과 과장·출처에 없는 문장 추가)했다. 변형 내용은 `bench/build-tasks.mjs` 에 명시돼 있으며 원 데이터의 주장이 아니다.
이 데이터는 저장소의 MIT 라이선스 대상이 아니며 위 라이선스를 따른다.
