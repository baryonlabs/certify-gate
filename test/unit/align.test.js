import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, numbersIn, splitSentences } from '../../src/align.js';
import { parseInterpretations, termToItem, itemToTerm } from '../../src/ontology.js';

test('숫자 추출: 식별자 속 숫자는 무시, 쉼표·가운뎃점 정규화', () => {
  assert.deepEqual(numbersIn('CX3CR1 and Kir7.1 in 5,179 agents, 11·9 million'), ['5179', '11.9']);
});

test('14% 초안(워킹페이퍼) vs 15% 출판본: 판본 불일치 강조', () => {
  const it = {
    sentences: ['생산성이 평균 14% 향상.'],
    sources: [
      { edition: '워킹페이퍼', text: 'productivity by 14% on average.' },
      { edition: '출판본', text: 'productivity by 15% on average.' },
    ],
  };
  const f = analyze(it)[0].flags;
  assert.ok(f.some((x) => x.type === 'edition' && x.token === '14'));
});

test('원문에 없는 연도는 year 플래그', () => {
  const it = { sentences: ['Coase 1973 argued firms exist.'], sources: [{ text: 'In 1937 Coase argued that firms exist because of transaction costs.' }] };
  assert.ok(analyze(it)[0].flags.some((x) => x.type === 'year' && x.token === '1973'));
});

test('쟁점 정의를 두 해석으로 분리', () => {
  assert.equal(parseInterpretations('[쟁점] 15%(출판본) vs 14%(워킹페이퍼)').length, 2);
  assert.equal(parseInterpretations('일반 정의'), null);
});

test('term ↔ item 왕복 시 형식 유지(추가 필드 보존)', () => {
  const term = { id: 't', label: 'T', definition: '하나. 둘.', status: 'draft', sources: ['k'], round: 3, domain: '철학' };
  const it = termToItem(term, { sources: { k: { label: 'K', text: '하나. 둘.' } } });
  assert.deepEqual(it.sentences, ['하나.', '둘.']);
  const back = itemToTerm({ ...it, status: 'certified', certification: { by: '저자' } }, term);
  assert.equal(back.domain, '철학');
  assert.deepEqual(back.sources, ['k']);
  assert.equal(back.status, 'certified');
  assert.deepEqual(splitSentences('가나. 다라; 마바'), ['가나.', '다라', '마바']);
});
