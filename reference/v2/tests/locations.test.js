import test from 'node:test';
import assert from 'node:assert/strict';
import { getCountries, getRegions, getCities, locationExists } from '../src/locations.js';

test('location directory returns a country → region → city hierarchy', () => {
  assert.ok(getCountries().includes('تنزانيا'));
  assert.ok(getRegions('تنزانيا').includes('بيمبا الشمالية'));
  assert.ok(getCities('تنزانيا', 'بيمبا الشمالية').includes('ويتي'));
});

test('unknown hierarchy values return empty lists safely', () => {
  assert.deepEqual(getRegions('بلد غير موجود'), []);
  assert.deepEqual(getCities('تنزانيا', 'محافظة غير موجودة'), []);
});

test('locationExists validates all three administrative levels', () => {
  assert.equal(locationExists('تنزانيا', 'بيمبا الجنوبية', 'مكواني'), true);
  assert.equal(locationExists('تنزانيا', 'بيمبا الجنوبية', 'مدينة أخرى'), false);
});
