import { describe, expect, it } from 'vitest';
import {
  areaPath,
  buildAreaTree,
  childrenOf,
  searchAreas,
  selectedAncestor,
  unknownIds,
} from './areaTree';
import { AdminError, adminErrorKey, functionError, restError } from './errors';
import {
  clearFxPlaceholder,
  currentNumber,
  fxPlaceholderActive,
  settingDef,
  settingLabelKey,
  SETTING_DEFS,
  validateSettingInput,
} from './settingsSchema';
import type { AreaNode } from './types';
import { SyncError } from '../sync/errors';

describe('settings schema (reference-data.md §5)', () => {
  it('covers the public numeric settings with their defaults inside the limits', () => {
    expect(SETTING_DEFS.map((d) => d.key)).toContain('duplicates.radius_m');
    for (const def of SETTING_DEFS) {
      expect(def.fallback).toBeGreaterThanOrEqual(def.min);
      expect(def.fallback).toBeLessThanOrEqual(def.max);
    }
    expect(settingLabelKey('duplicates.radius_m')).toBe('admin.setting_duplicates_radius_m');
  });

  it('validates what the administrator typed', () => {
    const radius = settingDef('duplicates.radius_m')!;
    expect(validateSettingInput(radius, ' 200 ')).toEqual({ value: 200, error: null });
    expect(validateSettingInput(radius, '')).toEqual({
      value: null,
      error: { key: 'admin.v_required' },
    });
    expect(validateSettingInput(radius, 'abc').error?.key).toBe('admin.v_number');
    expect(validateSettingInput(radius, '150.5').error?.key).toBe('admin.v_integer');
    expect(validateSettingInput(radius, '5').error).toEqual({
      key: 'admin.v_range',
      params: { min: 10, max: 2000 },
    });
    const quality = settingDef('photos.quality')!;
    expect(validateSettingInput(quality, '0,85')).toEqual({ value: 0.85, error: null });
    expect(validateSettingInput(quality, '1').error?.key).toBe('admin.v_range');
  });

  it('falls back to the default for a non-number', () => {
    const radius = settingDef('duplicates.radius_m')!;
    expect(currentNumber(radius, 300)).toBe(300);
    expect(currentNumber(radius, '300')).toBe(150);
  });

  it('reads and clears the fx.placeholder flag keeping its other keys', () => {
    const value = {
      placeholder: true,
      effective_date: '2025-01-01',
      currencies: ['TZS'],
      note: 'n',
    };
    expect(fxPlaceholderActive(value)).toBe(true);
    expect(fxPlaceholderActive(true)).toBe(true);
    expect(fxPlaceholderActive({ placeholder: false })).toBe(false);
    expect(fxPlaceholderActive(null)).toBe(false);
    const cleared = clearFxPlaceholder(value);
    expect(cleared).toMatchObject({
      placeholder: false,
      effective_date: '2025-01-01',
      currencies: ['TZS'],
      note: 'n',
    });
    expect(fxPlaceholderActive(cleared)).toBe(false);
    expect(typeof cleared.cleared_at).toBe('string');
  });
});

describe('admin area tree', () => {
  const area = (id: string, parent: string | null, level: number, name: string): AreaNode => ({
    id,
    country_id: 'tz',
    parent_id: parent,
    level,
    name_ar: null,
    name_en: name,
    name_sw: null,
  });
  const rows = [
    area('pn', null, 1, 'North Pemba'),
    area('ps', null, 1, 'South Pemba'),
    area('wete', 'pn', 2, 'Wete'),
    area('micheweni', 'pn', 2, 'Micheweni'),
    area('kojani', 'wete', 3, 'Kojani'),
    area('orphan', 'elsewhere', 2, 'Orphan Ward'),
  ];
  const tree = buildAreaTree(rows, (a) => a.name_en ?? '');

  it('builds roots and sorted children; unknown parents become roots', () => {
    expect(childrenOf(tree, null).map((a) => a.id)).toEqual(['pn', 'orphan', 'ps']);
    expect(childrenOf(tree, 'pn').map((a) => a.id)).toEqual(['micheweni', 'wete']);
  });

  it('paths, search and covered areas', () => {
    expect(areaPath(tree, 'kojani').map((a) => a.id)).toEqual(['pn', 'wete', 'kojani']);
    expect(searchAreas(tree, 'pemba').map((a) => a.id)).toEqual(['pn', 'ps']);
    // Prefix matches first, then substring matches ("Micheweni").
    expect(searchAreas(tree, 'we').map((a) => a.id)).toEqual(['wete', 'micheweni']);
    expect(searchAreas(tree, 'w')).toEqual([]);
    expect(selectedAncestor(tree, 'kojani', new Set(['pn']))).toBe('pn');
    expect(selectedAncestor(tree, 'kojani', new Set(['kojani']))).toBeNull();
    expect(unknownIds(tree, ['pn', 'gone'])).toEqual(['gone']);
  });
});

describe('error translation', () => {
  it('server codes of the admin RPCs get their own text', () => {
    expect(adminErrorKey(new AdminError('conflict', 'last_hq_admin', 409))).toBe(
      'admin.err_last_hq_admin',
    );
    expect(adminErrorKey(new AdminError('conflict', 'cannot_deactivate_self', 409))).toBe(
      'admin.err_cannot_deactivate_self',
    );
    expect(adminErrorKey(new AdminError('forbidden', 'mfa_required', 403))).toBe(
      'admin.err_mfa_required',
    );
  });

  it('reads the code out of a SyncError of the transport', () => {
    const e = new SyncError('conflict', 'admin_remove_role: last_hq_admin', { status: 409 });
    expect(adminErrorKey(e)).toBe('admin.err_last_hq_admin');
    expect(adminErrorKey(new SyncError('network', 'fetch failed'))).toBe('admin.err_network');
  });

  it('maps direct PostgREST errors', () => {
    expect(restError({ code: '23505', message: 'duplicate key' }, 409).code).toBe('duplicate');
    expect(restError({ code: '42501', message: 'rls' }, 403).kind).toBe('forbidden');
    expect(restError({ code: 'PT403', message: 'mfa_required' }, 403).code).toBe('mfa_required');
    expect(restError({ code: 'PGRST301', message: 'jwt expired' }, 401).kind).toBe(
      'unauthenticated',
    );
    expect(adminErrorKey(restError({ code: '23503', message: 'fk' }, 409))).toBe(
      'admin.err_reference',
    );
  });

  it('maps admin function errors', () => {
    expect(functionError(409, { code: 'PT409', message: 'user_exists' }).code).toBe('user_exists');
    expect(adminErrorKey(functionError(409, { message: 'user_exists' }))).toBe(
      'admin.err_user_exists',
    );
    expect(adminErrorKey(functionError(500, null))).toBe('admin.err_server');
    expect(adminErrorKey(new Error('x'))).toBe('admin.err_unknown');
  });
});
