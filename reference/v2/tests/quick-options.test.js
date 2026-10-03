import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_OPTIONS, normalizeMultiValue, mergeMultiSelection, formatMultiValue } from '../src/quick-options.js';

test('quick questionnaire defines concise choices for every long-text field', () => {
  const expected=['daawaActivities','socialFeatures','livelihoods','religiousIssues','religiousChallenges','socialChallenges','proposedActivities'];
  assert.deepEqual(Object.keys(QUICK_OPTIONS),expected);
  for(const key of expected){
    assert.ok(QUICK_OPTIONS[key].length>=6);
    assert.ok(QUICK_OPTIONS[key].length<=9);
  }
});

test('multi-choice values preserve old text and remove duplicates', () => {
  assert.deepEqual(normalizeMultiValue('الفقر، البطالة\nضعف النقل'),['الفقر','البطالة','ضعف النقل']);
  assert.deepEqual(mergeMultiSelection(['الفقر','البطالة'],'الفقر، أخرى'),['الفقر','البطالة','أخرى']);
  assert.equal(formatMultiValue(['الفقر','البطالة']),'الفقر، البطالة');
});
