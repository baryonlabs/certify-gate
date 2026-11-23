#!/usr/bin/env python3
"""제3자 질문 13개를 Baryon AX(https://github.com/baryonlabs/baryon-ax) 채팅 API에 두 조건으로 묻는다.
  (가) baseline: use_retrieval=false (검색 끔)
  (라) loop:     use_retrieval=true  (루프가 쌓은 온톨로지 검색)
사용: BARYON_AX_URL=http://<호스트>:8000 python3 run_eval.py questions.json answers.json
- 공개본은 원래 실행 스크립트에서 내부 접속 경로(SSH 호스트·내부 IP)와 권한 헤더를 지우고 환경 변수로 바꾼 것이다.
- 응답 모델: Qwen3.5-27B(vLLM, 사고 모드 끔, 문맥 32K), 오프라인 로컬 서버.
- (나) 원문 검색·(다) 원문 300자 조각 검색 조건의 실행 스크립트는 보존되지 않았다(결과는 answers_rag*.json).
"""
import json, os, random, sys, urllib.request

URL = os.environ.get("BARYON_AX_URL", "http://127.0.0.1:8000").rstrip("/") + "/v1/chat/completions"
EXTRA_HEADERS = json.loads(os.environ.get("BARYON_AX_HEADERS", "{}"))  # 예: '{"x-roles":"..."}' (서버 설정에 따름)

def ask(q, ret):
    body = json.dumps({"messages": [{"role": "user", "content": q}], "stream": False,
                       "use_retrieval": ret, "use_memory": False}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json", **EXTRA_HEADERS})
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            j = json.loads(r.read().decode(), strict=False)
        return j["choices"][0]["message"]["content"], len(j.get("citations") or j.get("sources") or [])
    except Exception as e:
        return "(오류) " + str(e)[:200], 0

def main():
    Q = json.load(open(sys.argv[1]))
    out = []
    for q in Q:
        for cond, ret in (("baseline", False), ("loop", True)):
            a, c = ask(q["question"], ret)
            out.append({"id": q["id"], "cond": cond, "answer": a, "citations": c})
            print(q["id"], cond, c, a[:60].replace("\n", " "), flush=True)
    random.seed(7)
    for i, o in enumerate(out):
        o["blind_id"] = f"A{i:03d}"
    json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
