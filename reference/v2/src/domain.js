const ALLOWED_TYPES = new Set(['mosque', 'school', 'combined']);
const ALLOWED_STATUSES = new Set(['active', 'maintenance', 'building', 'inactive']);

export function validateProject(project = {}) {
  const errors = {};
  if (!String(project.name ?? '').trim()) errors.name = 'اسم المشروع مطلوب';
  if (!ALLOWED_TYPES.has(project.type)) errors.type = 'نوع المشروع غير صحيح';
  if (!String(project.country ?? '').trim()) errors.country = 'الدولة مطلوبة';
  if (!String(project.region ?? '').trim()) errors.region = 'المنطقة مطلوبة';
  const locationMissing = project.lat === null || project.lat === undefined || String(project.lat).trim() === '' ||
    project.lng === null || project.lng === undefined || String(project.lng).trim() === '';
  const lat = Number(project.lat), lng = Number(project.lng);
  if (locationMissing || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    errors.location = 'الموقع الجغرافي غير صحيح';
  }
  const capacity = Number(project.capacity ?? 0);
  if (!Number.isFinite(capacity) || capacity < 0) errors.capacity = 'السعة يجب أن تكون صفرًا أو أكثر';
  if (!ALLOWED_STATUSES.has(project.status)) errors.status = 'حالة المشروع غير صحيحة';
  if (project.land?.area !== undefined && (Number(project.land.area) < 0 || !Number.isFinite(Number(project.land.area)))) errors.landArea = 'مساحة الأرض غير صحيحة';
  if (project.land?.utilization !== undefined && (Number(project.land.utilization) < 0 || Number(project.land.utilization) > 100 || !Number.isFinite(Number(project.land.utilization)))) errors.landUtilization = 'نسبة استغلال الأرض يجب أن تكون بين 0 و100';
  if (project.facilities?.quranNeed !== undefined && (Number(project.facilities.quranNeed) < 0 || !Number.isFinite(Number(project.facilities.quranNeed)))) errors.quranNeed = 'احتياج المصاحف غير صحيح';
  for (const key of ['quranCount','hallCapacity']) if (project.facilities?.[key] !== undefined && (Number(project.facilities[key]) < 0 || !Number.isFinite(Number(project.facilities[key])))) errors.facilities = 'بيانات المرافق العددية غير صحيحة';
  for (const key of ['muslimPercentage','omaniStudentPercentage','ibadiStudentPercentage','omaniTeacherPercentage','ibadiTeacherPercentage']) if (project.community?.[key] !== undefined && (Number(project.community[key]) < 0 || Number(project.community[key]) > 100 || !Number.isFinite(Number(project.community[key])))) errors.communityPercentage = 'النسب في بيانات المنطقة يجب أن تكون بين 0 و100';
  for (const key of ['population','ibadiFamilies','omaniFamilies']) if (project.community?.[key] !== undefined && (Number(project.community[key]) < 0 || !Number.isFinite(Number(project.community[key])))) errors.communityCount = 'الأعداد في بيانات المنطقة غير صحيحة';
  if (project.staff !== undefined) {
    if (!Array.isArray(project.staff) || project.staff.some(person => !String(person.name ?? '').trim() || !String(person.role ?? '').trim() || Number(person.salary ?? 0) < 0 || !Number.isFinite(Number(person.salary ?? 0)))) errors.staff = 'بيانات الكادر غير صحيحة';
  }
  if (project.photos !== undefined && (!Array.isArray(project.photos) || project.photos.some(photo => !photo || typeof photo.data !== 'string' || !/^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+=*$/i.test(photo.data)))) errors.photos = 'بيانات الصور غير صالحة؛ استخدم صورًا محلية';
  return { valid: Object.keys(errors).length === 0, errors };
}

export function filterProjects(projects, filters = {}) {
  const query = String(filters.query ?? '').trim().toLocaleLowerCase('ar');
  return projects.filter(project => {
    const haystack = [project.name, project.country, project.region, project.locality, project.manager, project.donor]
      .filter(Boolean).join(' ').toLocaleLowerCase('ar');
    return (!query || haystack.includes(query)) &&
      (!filters.type || filters.type === 'all' || project.type === filters.type) &&
      (!filters.region || filters.region === 'all' || project.region === filters.region) &&
      (!filters.status || filters.status === 'all' || project.status === filters.status);
  });
}

export function calculateStats(projects) {
  return projects.reduce((stats, project) => {
    stats.total += 1;
    stats.capacity += Number(project.capacity) || 0;
    if (project.status === 'maintenance') stats.maintenance += 1;
    if (Object.hasOwn(stats.types, project.type)) stats.types[project.type] += 1;
    return stats;
  }, { total: 0, capacity: 0, maintenance: 0, types: { mosque: 0, school: 0, combined: 0 } });
}

export function calculateOperationalStats(projects) {
  return projects.reduce((stats, project) => {
    const staff = Array.isArray(project.staff) ? project.staff : [];
    stats.staff += staff.length;
    stats.monthlyPayroll += staff.reduce((sum, person) => sum + (Number(person.salary) || 0), 0);
    if (project.land?.expandable === true) stats.expandableSites += 1;
    stats.quranNeed += Number(project.facilities?.quranNeed) || 0;
    if (project.facilities?.teacherHousing === false) stats.housingGaps += 1;
    if (project.facilities?.imamHousing === false) stats.housingGaps += 1;
    if (project.facilities?.studentTransport === 'needed') stats.transportNeeds += 1;
    return stats;
  }, { staff:0, monthlyPayroll:0, expandableSites:0, quranNeed:0, housingGaps:0, transportNeeds:0 });
}

function csvCell(value) {
  let text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function projectsToCsv(projects) {
  const field = key => project => project[key];
  const columns = [
    ['الرقم', field('id')], ['اسم المشروع', field('name')], ['النوع', field('type')], ['الدولة', field('country')],
    ['المنطقة', field('region')], ['الموقع المحلي', field('locality')], ['خط العرض', field('lat')], ['خط الطول', field('lng')],
    ['السعة', field('capacity')], ['الحالة', field('status')], ['المسؤول', field('manager')], ['الهاتف', field('phone')],
    ['الجهة البانية', field('builder')], ['المتبرع', field('donor')], ['تاريخ البناء', field('buildDate')], ['ملاحظات الصيانة', field('maintenanceNotes')],
    ['عدد الكادر', p => p.staff?.length || 0], ['أسماء الكادر', p => (p.staff || []).map(s => `${s.name} (${s.role})`).join('؛ ')], ['إجمالي الرواتب الشهرية', p => (p.staff || []).reduce((sum,s)=>sum+(Number(s.salary)||0),0)],
    ['ملكية الأرض', p => p.land?.ownership], ['مالك الأرض', p => p.land?.ownerName], ['مساحة الأرض', p => p.land?.area], ['نسبة الاستغلال', p => p.land?.utilization], ['قابلية التوسع', p => p.land?.expandable],
    ['سكن المعلمين', p => p.facilities?.teacherHousing], ['سكن الإمام', p => p.facilities?.imamHousing], ['سكن الضيوف', p => p.facilities?.guestHousing], ['المكتبة', p => p.facilities?.library], ['عدد المصاحف', p => p.facilities?.quranCount], ['المصاحف المطلوبة', p => p.facilities?.quranNeed], ['القاعة', p => p.facilities?.hall], ['سعة القاعة', p => p.facilities?.hallCapacity], ['نقل الطلاب', p => p.facilities?.studentTransport],
    ['اسم الفرع', p => p.community?.branchName], ['عدد السكان', p => p.community?.population], ['نسبة المسلمين', p => p.community?.muslimPercentage], ['النشاط الدعوي', p => p.community?.daawaActivities], ['التحديات الدينية', p => p.community?.religiousChallenges], ['التحديات الاجتماعية', p => p.community?.socialChallenges], ['الأنشطة المقترحة', p => p.community?.proposedActivities]
  ];
  const rows = [columns.map(([label]) => csvCell(label)).join(',')];
  for (const project of projects) rows.push(columns.map(([, getter]) => csvCell(getter(project))).join(','));
  return `\uFEFF${rows.join('\r\n')}`;
}

export function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ProjectRepository {
  constructor(storage = globalThis.localStorage, key = 'istiqama-projects-v2') {
    this.storage = storage;
    this.key = key;
  }
  list() {
    try {
      const value = JSON.parse(this.storage.getItem(this.key) || '[]');
      return Array.isArray(value) ? clone(value) : [];
    } catch { return []; }
  }
  get(id) { return this.list().find(project => project.id === id) ?? null; }
  persist(projects) { this.storage.setItem(this.key, JSON.stringify(projects)); return projects; }
  seed(projects) { if (this.storage.getItem(this.key) === null) this.persist(clone(projects)); return this.list(); }
  create(input) {
    const now = new Date().toISOString();
    const project = { ...clone(input), id: input.id || makeId(), createdAt: input.createdAt || now, updatedAt: now };
    const result = validateProject(project);
    if (!result.valid) throw new Error(Object.values(result.errors)[0]);
    this.persist([...this.list(), project]);
    return clone(project);
  }
  update(id, changes) {
    let updated = null;
    const projects = this.list().map(project => {
      if (project.id !== id) return project;
      updated = { ...project, ...clone(changes), id, updatedAt: new Date().toISOString() };
      const result = validateProject(updated);
      if (!result.valid) throw new Error(Object.values(result.errors)[0]);
      return updated;
    });
    if (!updated) throw new Error('المشروع غير موجود');
    this.persist(projects);
    return clone(updated);
  }
  remove(id) { const before = this.list(); this.persist(before.filter(project => project.id !== id)); return before.some(project => project.id === id); }
  replaceAll(projects) {
    if (!Array.isArray(projects)) throw new Error('ملف البيانات غير صحيح');
    const normalized = clone(projects).map(project => ({ ...project, id: String(project.id ?? '').trim() || makeId() }));
    const ids = new Set();
    for (const project of normalized) {
      if (ids.has(project.id)) throw new Error(`معرّف مشروع مكرر: ${project.id}`);
      ids.add(project.id);
      if (project.photo && !/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(project.photo)) {
        throw new Error('الصورة المستوردة غير مسموح بها');
      }
      const result = validateProject(project);
      if (!result.valid) throw new Error(`بيانات غير صالحة: ${Object.values(result.errors)[0]}`);
    }
    this.persist(normalized);
    return this.list();
  }
}
