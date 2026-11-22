// 작업 데이터 저장소. 원본 ontology.json은 절대 수정하지 않고 작업 디렉터리의 복사본만 다룬다.
import fs from 'node:fs';
import path from 'node:path';
import { termToItem, itemToTerm, validateOntology } from './ontology.js';

export class Store {
  /**
   * opts: { dataDir, seedDir, itemsFile, persist }
   *  - itemsFile가 있으면(벤치마크) 항목 배열을 그대로 읽고 저장하지 않는다.
   */
  constructor({ dataDir, seedDir, itemsFile = null, persist = true, logFile = null }) {
    this.dataDir = dataDir;
    this.seedDir = seedDir;
    this.itemsFile = itemsFile;
    this.persist = persist && !itemsFile;
    fs.mkdirSync(dataDir, { recursive: true });
    this.logFile = logFile ?? path.join(dataDir, 'certifications.jsonl');
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    this.load();
  }

  p(name) {
    return path.join(this.dataDir, name);
  }

  load() {
    if (this.itemsFile) {
      const raw = JSON.parse(fs.readFileSync(this.itemsFile, 'utf8'));
      this.ontology = { updated: null, terms: [], relations: [], questions: [] };
      this.items = new Map((raw.items ?? raw).map((it) => [it.id, it]));
      this.sourcesDb = { sources: {} };
      return;
    }
    for (const f of ['ontology.json', 'sources.json']) {
      if (!fs.existsSync(this.p(f)) && fs.existsSync(path.join(this.seedDir, f))) {
        fs.copyFileSync(path.join(this.seedDir, f), this.p(f));
      }
    }
    this.ontology = JSON.parse(fs.readFileSync(this.p('ontology.json'), 'utf8'));
    this.sourcesDb = fs.existsSync(this.p('sources.json')) ? JSON.parse(fs.readFileSync(this.p('sources.json'), 'utf8')) : { sources: {} };
    this.items = new Map(this.ontology.terms.map((t) => [t.id, termToItem(t, this.sourcesDb)]));
  }

  /** 외부 ontology.json을 복사해 들여온다(원본 불변). */
  importOntology(srcPath) {
    const o = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    const errs = validateOntology(o);
    if (errs.length) throw new Error(`형식 오류: ${errs.join('; ')}`);
    if (!this.persist) throw new Error('벤치마크 모드에서는 가져오기 불가');
    fs.writeFileSync(this.p('ontology.json'), JSON.stringify(o, null, 1));
    this.load();
    return this.items.size;
  }

  list() {
    return [...this.items.values()];
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  put(item) {
    this.items.set(item.id, item);
    if (!this.persist) return;
    const idx = this.ontology.terms.findIndex((t) => t.id === item.id);
    const term = itemToTerm(item, idx >= 0 ? this.ontology.terms[idx] : {});
    if (idx >= 0) this.ontology.terms[idx] = term;
    else this.ontology.terms.push(term);
    this.ontology.updated = new Date().toISOString().slice(0, 10);
    const tmp = this.p('ontology.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this.ontology, null, 1));
    fs.renameSync(tmp, this.p('ontology.json'));
  }

  exportOntology() {
    if (!this.persist) {
      return { updated: null, terms: this.list().map((it) => itemToTerm(it)), relations: [], questions: [] };
    }
    return JSON.parse(JSON.stringify(this.ontology));
  }

  appendLog(rec) {
    fs.appendFileSync(this.logFile, JSON.stringify(rec) + '\n');
  }

  readLog() {
    if (!fs.existsSync(this.logFile)) return [];
    return fs
      .readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}
