import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPracticeLines, MODEL_CHOICES, VOICES } from '../web/core.js';

test('splits only on user-provided line breaks', () => {
  assert.deepEqual(splitPracticeLines('Hello. How are you?\nNext line!'), ['Hello. How are you?', 'Next line!']);
});
test('normalizes CRLF and discards empty paragraphs', () => {
  assert.deepEqual(splitPracticeLines(' First \r\n\r\n Second\rThird '), ['First', 'Second', 'Third']);
});
test('keeps apostrophes and punctuation', () => {
  assert.deepEqual(splitPracticeLines("I didn't know.\nIs that so?"), ["I didn't know.", 'Is that so?']);
});
test('models and voices provide offline selection', () => {
  assert.equal(MODEL_CHOICES.length, 2);
  assert(VOICES.some(voice => voice[0] === 'aiden'));
});
