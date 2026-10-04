import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => {
  const phone = await import('../auth/phone');
  return { DIAL_COUNTRIES: phone.DIAL_COUNTRIES };
});

import {
  cleanPhoneInput,
  dialForIso,
  dialFromTimeZone,
  isoForDial,
  isPersonE164,
  splitE164,
  toPersonE164,
} from './phone';

describe('toPersonE164 — the calling code of the user’s country', () => {
  it.each([
    // [typed, dial, expected]
    ['0712 345 678', '255', '+255712345678'], // Tanzania, trunk zero
    ['712345678', '255', '+255712345678'],
    ['0712-345-678', '254', '+254712345678'], // Kenya
    ['0772 123456', '256', '+256772123456'], // Uganda
    ['0788 123 456', '250', '+250788123456'], // Rwanda
    ['79 12 34 56', '257', '+25779123456'], // Burundi, 8 digits
    ['84 123 4567', '258', '+258841234567'], // Mozambique
    ['9123 4567', '968', '+96891234567'], // Oman, 8 digits
  ])('%s with +%s → %s', (typed, dial, expected) => {
    expect(toPersonE164(typed, dial)).toBe(expected);
  });

  it('keeps a number typed in international form, whatever prefix is selected', () => {
    expect(toPersonE164('+254 712 345 678', '255')).toBe('+254712345678');
    expect(toPersonE164('00254712345678', '255')).toBe('+254712345678');
    expect(toPersonE164('+968 9123 4567', null)).toBe('+96891234567');
  });

  it('does not prefix the calling code twice', () => {
    expect(toPersonE164('255712345678', '255')).toBe('+255712345678');
    expect(toPersonE164('96891234567', '968')).toBe('+96891234567');
  });

  it('maps Arabic-Indic and Extended Arabic-Indic digits', () => {
    const arabicIndic = String.fromCodePoint(
      0x660,
      0x667,
      0x661,
      0x662,
      0x663,
      0x664,
      0x665,
      0x666,
      0x667,
      0x668,
    );
    expect(toPersonE164(arabicIndic, '255')).toBe('+255712345678');
    const persian = String.fromCodePoint(
      0x6f0,
      0x6f7,
      0x6f1,
      0x6f2,
      0x6f3,
      0x6f4,
      0x6f5,
      0x6f6,
      0x6f7,
      0x6f8,
    );
    expect(toPersonE164(persian, '254')).toBe('+254712345678');
  });

  it('rejects what cannot be stored (persons_phone_ck: 7–15 digits)', () => {
    expect(toPersonE164('', '255')).toBeNull();
    expect(toPersonE164('+', '255')).toBeNull();
    expect(toPersonE164('12', null)).toBeNull(); // national number without calling code
    expect(toPersonE164('0712345678', null)).toBeNull();
    expect(toPersonE164('+0123456789', '255')).toBeNull(); // leading zero after +
    expect(toPersonE164('+1234567890123456', '255')).toBeNull(); // 16 digits
    expect(toPersonE164('000', '255')).toBeNull();
  });

  it('accepts short numbers the database accepts', () => {
    expect(toPersonE164('+2551234', null)).toBe('+2551234'); // 7 digits
    expect(isPersonE164('+2551234')).toBe(true);
    expect(isPersonE164('+255123')).toBe(false);
    expect(isPersonE164(null)).toBe(false);
  });
});

describe('phone helpers', () => {
  it('maps ISO codes and calling codes of the served countries', () => {
    expect(dialForIso('tz')).toBe('255');
    expect(dialForIso('OM')).toBe('968');
    expect(dialForIso('FR')).toBeNull();
    expect(dialForIso(null)).toBeNull();
    expect(isoForDial('254')).toBe('KE');
    expect(isoForDial('33')).toBeNull();
  });

  it('guesses the country from the device time zone', () => {
    expect(dialFromTimeZone('Africa/Nairobi')).toBe('254');
    expect(dialFromTimeZone('Asia/Muscat')).toBe('968');
    expect(dialFromTimeZone('Europe/Paris')).toBeNull();
  });

  it('splits a stored number for the edit form', () => {
    expect(splitE164('+255712345678')).toEqual({ dial: '255', national: '712345678' });
    expect(splitE164('+33612345678')).toEqual({ dial: null, national: '+33612345678' });
    expect(splitE164(null)).toEqual({ dial: null, national: '' });
  });

  it('keeps only digits and a leading plus', () => {
    expect(cleanPhoneInput(' +255 (712) 345-678 ')).toBe('+255712345678');
    expect(cleanPhoneInput('07+12')).toBe('0712');
  });
});
