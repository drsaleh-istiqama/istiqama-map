import { describe, expect, it } from 'vitest';
import type { PersonCandidate } from '../db';
import {
  combineCandidates,
  parseServerCandidates,
  rankCandidates,
  scriptOf,
  type ServerCandidate,
} from './candidates';

function local(id: string, over: Partial<PersonCandidate> = {}): PersonCandidate {
  return {
    id,
    name_ar: 'محمد علي',
    name_latin: null,
    phone: null,
    phone_masked: false,
    gender: null,
    birth_year: null,
    home_area: null,
    roles: [],
    staff: [],
    hidden_projects: 0,
    similarity: 0.7,
    same_area: false,
    reasons: ['name'],
    ...over,
  };
}

function server(id: string, over: Partial<ServerCandidate> = {}): ServerCandidate {
  return { ...local(id), ...over } as ServerCandidate;
}

const staff = (id: string, role: 'imam' | 'teacher' = 'imam') => ({
  project_staff_id: id,
  project_id: `p-${id}`,
  project_code: 'TZ-PN-000001',
  project_name_ar: 'مسجد النور',
  project_name_latin: null,
  project_type: 'mosque' as const,
  role,
  start_date: '2020-01-01',
  end_date: null,
});

describe('rankCandidates', () => {
  it('orders phone matches, then same area, then similarity, then name', () => {
    const list = rankCandidates([
      local('a', { similarity: 0.95 }),
      local('b', { similarity: 0.65, same_area: true, reasons: ['name', 'area'] }),
      local('c', { similarity: null, reasons: ['phone'] }),
      local('d', { similarity: 0.8, name_ar: 'أحمد' }),
      local('e', { similarity: 0.8, name_ar: 'بكر' }),
    ]);
    expect(list.map((c) => c.id)).toEqual(['c', 'b', 'a', 'd', 'e']);
  });
});

describe('combineCandidates', () => {
  it('lists every person once and keeps persons the server does not know yet', () => {
    const out = combineCandidates(
      [local('only-device'), local('both', { similarity: 0.7 })],
      [server('both', { similarity: 0.9 }), server('only-server')],
    );
    expect(out.map((c) => c.id).sort()).toEqual(['both', 'only-device', 'only-server']);
    expect(out.find((c) => c.id === 'both')!.origin).toBe('both');
    expect(out.find((c) => c.id === 'both')!.similarity).toBe(0.9);
    expect(out.find((c) => c.id === 'only-device')!.origin).toBe('local');
    expect(out.find((c) => c.id === 'only-server')!.origin).toBe('server');
  });

  it('unites reasons and assignments; the device copy wins for names and phone', () => {
    const [c] = combineCandidates(
      [
        local('x', {
          name_ar: 'اسم محدَّث',
          phone: '+255711000001',
          reasons: ['name'],
          staff: [staff('s1')],
          roles: ['imam'],
        }),
      ],
      [
        server('x', {
          name_ar: 'اسم قديم',
          phone: '+255 *** ***001',
          phone_masked: true,
          reasons: ['phone', 'area'],
          same_area: true,
          staff: [staff('s1'), staff('s2', 'teacher')],
          roles: ['imam', 'teacher'],
        }),
      ],
    );
    expect(c!.name_ar).toBe('اسم محدَّث');
    expect(c!.phone).toBe('+255711000001');
    expect(c!.phone_masked).toBe(false);
    expect(c!.reasons).toEqual(['phone', 'name', 'area']);
    expect(c!.same_area).toBe(true);
    expect(c!.staff.map((s) => s.project_staff_id)).toEqual(['s1', 's2']);
    expect(c!.roles).toEqual(['imam', 'teacher']);
  });

  it('keeps the server mask when the device has no phone for that person', () => {
    const [c] = combineCandidates(
      [],
      [server('y', { phone: '+255 *** ***999', phone_masked: true })],
    );
    expect(c!.phone_masked).toBe(true);
    expect(c!.phone).toBe('+255 *** ***999');
  });

  it('caps the list at 12 like the server', () => {
    const many = Array.from({ length: 20 }, (_, i) => local(`p${String(i).padStart(2, '0')}`));
    expect(combineCandidates(many, null)).toHaveLength(12);
  });
});

describe('parseServerCandidates', () => {
  it('reads the documented shape and drops malformed elements', () => {
    const out = parseServerCandidates([
      {
        id: 'd0a9c8e2-4cdd-3f0c-b4cc-d858f32c255e',
        phone: '+255711000102',
        roles: ['manager'],
        staff: [
          {
            role: 'manager',
            end_date: null,
            project_id: '4f4d',
            start_date: '2021-02-01',
            project_code: 'TZ-PN-000002',
            project_type: 'school',
            project_name_ar: 'مدرسة الفلاح للقرآن',
            project_staff_id: '6871',
            project_name_latin: 'Madrasat Al-Falah',
          },
        ],
        gender: 'male',
        name_ar: 'محمد علي',
        reasons: ['name', 'bogus'],
        home_area: {
          id: '74e0',
          text: null,
          name_ar: 'بيمبا الشمالية',
          name_en: 'North Pemba',
          name_sw: 'Kaskazini Pemba',
        },
        same_area: false,
        birth_year: 1985,
        name_latin: 'Mohamed Ali',
        similarity: 1,
        phone_masked: false,
        hidden_projects: 0,
      },
      { no: 'id' },
      'garbage',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reasons).toEqual(['name']);
    expect(out[0]!.staff[0]!.project_code).toBe('TZ-PN-000002');
    expect(out[0]!.home_area!.name_en).toBe('North Pemba');
    expect(parseServerCandidates(null)).toEqual([]);
  });
});

describe('scriptOf', () => {
  it('tells Arabic from Latin text', () => {
    expect(scriptOf('محمد')).toBe('arabic');
    expect(scriptOf('Mohamed')).toBe('latin');
    expect(scriptOf('123')).toBe('none');
  });
});
