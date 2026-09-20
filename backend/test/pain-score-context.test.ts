import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePainScore } from '../../frontend/pain-score.js';

test('clock-shaped speech recognition answers require known pain-score context', () => {
  for (const [answer, expected] of [
    ['1:00', 1],
    ["It's 2:00.", 2],
    ['It is 3:00!', 3],
    ['My pain level is 4:00', 4],
    ['My pain score is 5:00', 5],
    ['A score of 6:00', 6],
    ["I'd rate it 7:00", 7],
    ['I think about 8:00', 8],
    ['It’s 9:00?', 9],
    ['10:00', 10],
  ] as const) {
    assert.equal(parsePainScore(answer), null, answer);
    assert.equal(parsePainScore(answer, {}), null, answer);
    assert.equal(parsePainScore(answer, { allowClockNotation: false }), null, answer);
    assert.equal(parsePainScore(answer, { allowClockNotation: true }), expected, answer);
  }
});

test('context does not turn actual times, ranges, or multiple quantities into pain scores', () => {
  for (const answer of [
    'at 2:00', 'started at 2:00', 'started at2:00', '2:00pm', '2:00 pm',
    'yesterday at 2:00', 'yesterday at2:00', "It's 2:00 AM.",
    '2:30', "It's 2:30.", '2:0', '02:00', '0:00', '11:00', '12:00',
    '2:00 or 3:00', '2:00–3:00', 'between 2:00 and 3:00',
    '2:00 out of 10', '2:00/10', '2:00 for 3 days',
    '2:00 and 2', '2 and 2:00', 'My pain is 2:00 since yesterday',
    'not 2:00', 'four or five', 'not seven', 'eleven', 'severe',
  ]) {
    assert.equal(parsePainScore(answer), null, answer);
    assert.equal(parsePainScore(answer, { allowClockNotation: true }), null, answer);
  }
});

test('ordinary whole-number pain answers retain existing behavior with or without context', () => {
  for (const [answer, expected] of [
    ["it's 2", 2], ['two', 2], ['two out of ten', 2], ['2/10', 2],
    ['My pain level is seven out of ten.', 7], ['I rate my pain as six', 6],
    ["I'd say about a four!", 4], ['1', 1], ['10', 10],
  ] as const) {
    assert.equal(parsePainScore(answer), expected, answer);
    assert.equal(parsePainScore(answer, { allowClockNotation: true }), expected, answer);
  }
  for (const answer of [undefined, null, '', 'zero', '0', '11', '2.5', '2 or 3']) {
    assert.equal(parsePainScore(answer), null);
    assert.equal(parsePainScore(answer, { allowClockNotation: true }), null);
  }
});
