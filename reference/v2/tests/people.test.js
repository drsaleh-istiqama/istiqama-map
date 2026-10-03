import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/domain.js';
import { PersonDirectory, normalizePersonName } from '../src/people.js';

test('person directory reuses the same Arabic name without duplicates', () => {
  const directory = new PersonDirectory(createMemoryStorage(), 'people-test');
  directory.upsert({ name:'  أحمد   سالم ', role:'teacher', education:'دبلوم' });
  directory.upsert({ name:'أحمد سالم', role:'imam', region:'بيمبا' });
  assert.equal(directory.list().length, 1);
  assert.deepEqual(directory.find('أحمد سالم').roles.sort(), ['imam','teacher']);
  assert.equal(directory.find('أحمد سالم').education, 'دبلوم');
  assert.equal(directory.find('أحمد سالم').region, 'بيمبا');
});

test('person directory seeds staff and project managers for reuse', () => {
  const directory = new PersonDirectory(createMemoryStorage(), 'people-test');
  directory.seedFromProjects([{ manager:'خالد حسن', staff:[{name:'محمد علي',role:'teacher',salary:200}] }]);
  assert.ok(directory.find('خالد حسن').roles.includes('manager'));
  assert.equal(directory.find('محمد علي').salary, 200);
});

test('normalizePersonName removes Arabic marks and duplicate whitespace', () => {
  assert.equal(normalizePersonName(' أَحـمد   سالم '), 'احمد سالم');
});
