import { describe, expect, it } from 'vitest';
import {
  DIAL_COUNTRIES,
  exampleNational,
  guessDialCountry,
  isE164,
  isValidEmail,
  toE164,
} from './phone';

describe('phone helper (E.164)', () => {
  it('offers the seven countries of the brief', () => {
    expect(DIAL_COUNTRIES.map((c) => `${c.iso2}+${c.dial}`)).toEqual([
      'TZ+255',
      'KE+254',
      'UG+256',
      'RW+250',
      'BI+257',
      'MZ+258',
      'OM+968',
    ]);
  });

  it('adds the country prefix to a national number and drops the trunk zero', () => {
    expect(toE164('0700 000 001', '255')).toBe('+255700000001');
    expect(toE164('700000001', '255')).toBe('+255700000001');
    expect(toE164('0712-345-678', '254')).toBe('+254712345678');
    expect(toE164('(0) 79 123 456', '257')).toBe('+25779123456');
    expect(toE164('9123 4567', '968')).toBe('+96891234567');
  });

  it('takes international input as typed, whatever prefix is selected', () => {
    expect(toE164('+254 700 000 001', '255')).toBe('+254700000001');
    expect(toE164('00254700000001', '255')).toBe('+254700000001');
    expect(toE164('+44 20 7946 0958', '255')).toBe('+442079460958');
  });

  it('does not prefix twice when the calling code was typed without "+"', () => {
    expect(toE164('255700000001', '255')).toBe('+255700000001');
  });

  it('accepts Arabic-Indic digits', () => {
    const arabicIndic = [0x0667, 0x0660, 0x0660, 0x0660, 0x0660, 0x0660, 0x0660, 0x0660, 0x0661]
      .map((code) => String.fromCodePoint(code))
      .join('');
    expect(toE164(arabicIndic, '255')).toBe('+255700000001');
  });

  it('rejects what cannot be a phone number', () => {
    expect(toE164('', '255')).toBeNull();
    expect(toE164('+', '255')).toBeNull();
    expect(toE164('12', '255')).toBeNull();
    expect(toE164('abc', '255')).toBeNull();
    expect(toE164('+0123456789', '255')).toBeNull();
    expect(toE164('7000000011234567890', '255')).toBeNull();
  });

  it('isE164', () => {
    expect(isE164('+255700000001')).toBe(true);
    expect(isE164('255700000001')).toBe(false);
    expect(isE164('+255 700 000 001')).toBe(false);
  });

  it('guesses the country from the device time zone', () => {
    expect(guessDialCountry('Africa/Nairobi').iso2).toBe('KE');
    expect(guessDialCountry('Asia/Muscat').iso2).toBe('OM');
    expect(guessDialCountry('Africa/Maputo').iso2).toBe('MZ');
    expect(guessDialCountry('Europe/Paris').iso2).toBe('TZ');
    expect(DIAL_COUNTRIES).toContain(guessDialCountry());
  });

  it('shows an example of the right length', () => {
    expect(exampleNational(DIAL_COUNTRIES[0]!)).toBe('712 345 678');
    expect(exampleNational(DIAL_COUNTRIES[6]!)).toBe('712 345 67');
  });

  it('validates e-mail addresses loosely', () => {
    expect(isValidEmail('collector.pemba@example.org')).toBe(true);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('two words@example.org')).toBe(false);
  });
});
