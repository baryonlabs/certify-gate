# Nemotron-Personas-Korea parquet 샤드에서 샘플링에 필요한 열만 JSONL로 뽑는다.
# 사용: uv run --with pyarrow python bench/persona-senior/parquet-to-jsonl.py OUT.jsonl SHARD.parquet...
import sys, json, pyarrow.parquet as pq
COLS = ['uuid', 'sex', 'age', 'province', 'district', 'occupation', 'education_level', 'persona', 'professional_persona', 'skills_and_expertise']
with open(sys.argv[1], 'w') as f:
    for path in sys.argv[2:]:
        shard = path.rsplit('train-', 1)[-1].split('.')[0]
        t = pq.read_table(path, columns=COLS).to_pylist()
        for i, r in enumerate(t):
            r['row_idx'] = f'{shard}:{i}'
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
        print(path, len(t))
