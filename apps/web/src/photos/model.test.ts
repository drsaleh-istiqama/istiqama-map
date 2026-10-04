import { describe, expect, it } from 'vitest';
import { newRow } from '../db';
import {
  addPhotoRow,
  cleanCaption,
  isPhotoCategory,
  livePhotos,
  MAX_PHOTOS,
  newPhotoRow,
  remainingSlots,
  removePhotoRow,
  replacePhotoRow,
  setCover,
  storagePaths,
  updatePhotoRow,
  withSingleCover,
  type PhotoRow,
} from './model';

const PROJECT = '01900000-0000-7000-8000-000000000001';

function photo(values: Partial<PhotoRow> = {}): PhotoRow {
  return newRow('project_photos', { project_id: PROJECT, ...values });
}

const covers = (rows: PhotoRow[]): string[] => rows.filter((r) => r.is_cover).map((r) => r.id);

describe('cover rule: exactly one live cover', () => {
  it('the first photo becomes the cover; later ones do not', () => {
    const a = photo();
    const b = photo();
    const one = addPhotoRow([], a);
    expect(covers(one)).toEqual([a.id]);
    const two = addPhotoRow(one, b);
    expect(covers(two)).toEqual([a.id]);
  });

  it('setCover moves the flag; it is never on two photos', () => {
    const rows = addPhotoRow(addPhotoRow(addPhotoRow([], photo()), photo()), photo());
    const third = rows[2] as PhotoRow;
    const next = setCover(rows, third.id);
    expect(covers(next)).toEqual([third.id]);
    expect(setCover(next, 'unknown')).toEqual(next);
  });

  it('deleting the cover promotes the next live photo', () => {
    const rows = addPhotoRow(addPhotoRow([], photo()), photo());
    const [first, second] = rows as [PhotoRow, PhotoRow];
    const next = removePhotoRow(rows, first.id);
    expect(next.map((r) => r.id)).toEqual([second.id]);
    expect(covers(next)).toEqual([second.id]);
    expect(removePhotoRow(next, second.id)).toEqual([]);
  });

  it('several covers (bad data) collapse to the first; deleted rows never keep it', () => {
    const deleted = photo({ is_cover: true, deleted_at: '2026-10-01T00:00:00Z' });
    const a = photo({ is_cover: true });
    const b = photo({ is_cover: true });
    const fixed = withSingleCover([deleted, a, b]);
    expect(covers(fixed)).toEqual([a.id]);
    expect(fixed[0]?.is_cover).toBe(false);
  });

  it('keeps the identity of rows that do not change', () => {
    const rows = addPhotoRow([], photo());
    expect(withSingleCover(rows)[0]).toBe(rows[0]);
  });
});

describe('limit of 10 photos', () => {
  it('counts live photos only', () => {
    const rows = Array.from({ length: 9 }, () => photo());
    expect(remainingSlots(rows)).toBe(1);
    expect(remainingSlots([...rows, photo()])).toBe(0);
    expect(remainingSlots([...rows, photo(), photo()])).toBe(0);
    expect(remainingSlots([...rows, photo({ deleted_at: '2026-10-01T00:00:00Z' })])).toBe(1);
    expect(livePhotos(rows)).toHaveLength(9);
    expect(MAX_PHOTOS).toBe(10);
  });
});

describe('retake', () => {
  it('the new photo takes the place, type, caption and cover flag of the old one', () => {
    const a = photo();
    const b = photo({ category: 'other', caption: 'المدخل' });
    const rows = setCover(addPhotoRow(addPhotoRow([], a), b), b.id);
    const fresh = photo();
    const next = replacePhotoRow(rows, b.id, fresh);
    expect(next.map((r) => r.id)).toEqual([a.id, fresh.id]);
    expect(next[1]).toMatchObject({ category: 'other', caption: 'المدخل', is_cover: true });
    expect(covers(next)).toEqual([fresh.id]);
  });

  it('replacing a photo that is gone adds the new one', () => {
    const fresh = photo();
    expect(replacePhotoRow([], 'gone', fresh).map((r) => r.id)).toEqual([fresh.id]);
  });
});

describe('fields', () => {
  it('updates category and caption of one photo', () => {
    const a = photo();
    const b = photo();
    const next = updatePhotoRow([a, b], b.id, { category: 'land', caption: 'x' });
    expect(next[0]).toBe(a);
    expect(next[1]).toMatchObject({ category: 'land', caption: 'x' });
  });

  it('validates categories and cleans captions', () => {
    expect(isPhotoCategory('mosque_front')).toBe(true);
    expect(isPhotoCategory('selfie')).toBe(false);
    expect(cleanCaption('   ')).toBeNull();
    expect(cleanCaption(' باب ')).toBe('باب');
    expect(cleanCaption('x'.repeat(500))).toHaveLength(160);
  });
});

describe('storage paths (schema.md §4.4)', () => {
  const PATH_RE =
    /^projects\/[A-Z]{2}\/[0-9a-f-]{36}\/[0-9a-f-]{36}_(full|thumb)\.(webp|jpg|jpeg)$/;

  it('follows the CHECK constraint for WebP and JPEG', () => {
    const id = '01900000-0000-7000-8000-0000000000aa';
    expect(storagePaths('TZ', PROJECT, id, 'image/webp')).toEqual({
      full: `projects/TZ/${PROJECT}/${id}_full.webp`,
      thumb: `projects/TZ/${PROJECT}/${id}_thumb.webp`,
    });
    const jpg = storagePaths('KE', PROJECT, id, 'image/jpeg');
    expect(jpg.full).toBe(`projects/KE/${PROJECT}/${id}_full.jpg`);
    expect(jpg.full).toMatch(PATH_RE);
    expect(jpg.thumb).toMatch(PATH_RE);
  });

  it('newPhotoRow fills paths, size and capture time; paths stay null without ISO2', () => {
    const full = new Blob([new Uint8Array(1234)], { type: 'image/webp' });
    const compressed = {
      full,
      width: 1600,
      height: 1200,
      takenAt: '2026-09-30T14:05:09+03:00',
      mime: 'image/webp' as const,
    };
    const row = newPhotoRow(PROJECT, compressed, 'TZ', { category: 'land', caption: ' ساحة ' });
    expect(row).toMatchObject({
      project_id: PROJECT,
      width: 1600,
      height: 1200,
      bytes: 1234,
      taken_at: '2026-09-30T14:05:09+03:00',
      category: 'land',
      caption: 'ساحة',
      is_cover: false,
      upload_state: 'pending',
      version: 0,
      storage_path_full: `projects/TZ/${PROJECT}/${row.id}_full.webp`,
      storage_path_thumb: `projects/TZ/${PROJECT}/${row.id}_thumb.webp`,
    });
    const unknown = newPhotoRow(PROJECT, compressed, null, { category: 'nonsense' });
    expect(unknown.storage_path_full).toBeNull();
    expect(unknown.category).toBe('unspecified');
  });
});
