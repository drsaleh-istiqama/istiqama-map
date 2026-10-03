import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProject,
  filterProjects,
  calculateStats,
  calculateOperationalStats,
  projectsToCsv,
  ProjectRepository,
  createMemoryStorage
} from '../src/domain.js';

const sample = [
  { id:'1', name:'مسجد النور', type:'mosque', country:'تنزانيا', region:'بيمبا', locality:'ويتي', lat:-5.055, lng:39.729, capacity:350, status:'active', manager:'عبدالله' },
  { id:'2', name:'مدرسة الفلاح', type:'school', country:'تنزانيا', region:'بيمبا', locality:'مكواني', lat:-5.359, lng:39.644, capacity:120, status:'maintenance', manager:'محمد' },
  { id:'3', name:'مسجد الرحمة', type:'combined', country:'تنزانيا', region:'زنجبار', locality:'مدينة زنجبار', lat:-6.165, lng:39.199, capacity:280, status:'active', manager:'خالد' }
];

test('validateProject rejects a project without a name', () => {
  const result = validateProject({ ...sample[0], name:'' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.name);
});

test('validateProject rejects invalid coordinates and negative capacity', () => {
  const result = validateProject({ ...sample[0], lat:91, lng:181, capacity:-1 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.location);
  assert.ok(result.errors.capacity);
});

test('validateProject rejects blank coordinates and missing classification fields', () => {
  const result = validateProject({ ...sample[0], lat:'', lng:'', country:'', region:'', status:'' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.location);
  assert.ok(result.errors.country);
  assert.ok(result.errors.region);
  assert.ok(result.errors.status);
});

test('validateProject accepts a complete project', () => {
  assert.deepEqual(validateProject(sample[0]), { valid:true, errors:{} });
});

test('filterProjects combines Arabic search, type, region and status', () => {
  const result = filterProjects(sample, { query:'الفلاح', type:'school', region:'بيمبا', status:'maintenance' });
  assert.deepEqual(result.map(p => p.id), ['2']);
});

test('calculateStats totals projects, capacity, maintenance and type counts', () => {
  assert.deepEqual(calculateStats(sample), {
    total:3, capacity:750, maintenance:1,
    types:{ mosque:1, school:1, combined:1 }
  });
});

test('calculateOperationalStats aggregates staff, salaries and operational needs', () => {
  const enriched = [
    { ...sample[0], staff:[{role:'imam',salary:100},{role:'teacher',salary:200}], land:{expandable:true}, facilities:{quranNeed:20,teacherHousing:false,imamHousing:true,studentTransport:'needed'} },
    { ...sample[1], staff:[{role:'administrator',salary:150}], land:{expandable:false}, facilities:{quranNeed:5,teacherHousing:true,imamHousing:false,studentTransport:'available'} }
  ];
  assert.deepEqual(calculateOperationalStats(enriched), { staff:3, monthlyPayroll:450, expandableSites:1, quranNeed:25, housingGaps:2, transportNeeds:1 });
});

test('validateProject rejects invalid nested land, facilities and staff values', () => {
  const result = validateProject({ ...sample[0], land:{area:-1,utilization:101}, facilities:{quranNeed:-2}, community:{muslimPercentage:101}, staff:[{name:'أحمد',role:'teacher',salary:-1}] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.landArea);
  assert.ok(result.errors.landUtilization);
  assert.ok(result.errors.quranNeed);
  assert.ok(result.errors.communityPercentage);
  assert.ok(result.errors.staff);
});

test('projectsToCsv writes UTF-8 BOM and escapes commas and quotes', () => {
  const csv = projectsToCsv([{ ...sample[0], name:'مسجد "الرحمة", الكبير' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"مسجد ""الرحمة"", الكبير"/);
  assert.match(csv, /عدد الكادر/);
  assert.match(csv, /ملكية الأرض/);
});

test('projectsToCsv serializes multi-choice answers readably', () => {
  const csv=projectsToCsv([{...sample[0],community:{religiousChallenges:['نقص الكادر','ضعف التمويل']}}]);
  assert.match(csv,/نقص الكادر \| ضعف التمويل/);
});

test('projectsToCsv neutralizes spreadsheet formula injection', () => {
  const csv = projectsToCsv([{ ...sample[0], name:'=HYPERLINK("https://evil.invalid")', donor:'+cmd' }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+cmd/);
});

test('ProjectRepository creates, updates and deletes projects persistently', () => {
  const storage = createMemoryStorage();
  const repo = new ProjectRepository(storage, 'projects-test');
  const created = repo.create({ ...sample[0], id:undefined });
  assert.ok(created.id);
  assert.equal(repo.list().length, 1);
  repo.update(created.id, { capacity:500 });
  assert.equal(repo.get(created.id).capacity, 500);
  repo.remove(created.id);
  assert.equal(repo.list().length, 0);
});

test('ProjectRepository seeds only when storage has never been initialized', () => {
  const storage = createMemoryStorage();
  const repo = new ProjectRepository(storage, 'projects-test');
  repo.seed(sample);
  repo.seed([{ ...sample[0], id:'other' }]);
  assert.equal(repo.list().length, 3);
  assert.equal(repo.get('other'), null);
  for (const project of [...repo.list()]) repo.remove(project.id);
  repo.seed(sample);
  assert.equal(repo.list().length, 0);
});

test('ProjectRepository import assigns missing ids and rejects duplicate ids atomically', () => {
  const storage = createMemoryStorage();
  const repo = new ProjectRepository(storage, 'projects-test');
  const imported = repo.replaceAll([{ ...sample[0], id:undefined }]);
  assert.ok(imported[0].id);
  assert.throws(() => repo.replaceAll([{ ...sample[0], id:'same' }, { ...sample[1], id:'same' }]), /مكرر/);
  assert.equal(repo.list().length, 1);
});

test('ProjectRepository import rejects remote image urls', () => {
  const storage = createMemoryStorage();
  const repo = new ProjectRepository(storage, 'projects-test');
  assert.throws(() => repo.replaceAll([{ ...sample[0], photo:'https://tracker.invalid/pixel.png' }]), /الصورة/);
  assert.equal(repo.list().length, 0);
});
