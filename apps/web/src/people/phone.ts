/**
 * Phone numbers of persons (brief §2.4: `persons.phone_e164`).
 *
 * The staff form offers the calling code of the user's own country as a prefix, so a field
 * collector types the national number the way it is written locally ("0712 345 678") and the
 * stored value is E.164 ("+255712345678"). A number typed in full international form
 * ("+254…", "00254…") keeps its own country code whatever prefix is selected.
 *
 * Validation follows the database check `persons_phone_ck`: `^\+[1-9][0-9]{6,14}$`
 * (7–15 digits), slightly wider than the sign-in check of `src/auth/phone.ts`.
 */
import { DIAL_COUNTRIES } from '../auth';

export type DialIso = (typeof DIAL_COUNTRIES)[number]['iso2'];

const PERSON_E164 = /^\+[1-9][0-9]{6,14}$/;

/** True when `phone` can be stored in `persons.phone_e164`. */
export function isPersonE164(phone: string | null | undefined): boolean {
  return typeof phone === 'string' && PERSON_E164.test(phone);
}

/** Calling code ("255") of a country by ISO 3166-1 alpha-2 code, or null when unknown. */
export function dialForIso(iso2: string | null | undefined): string | null {
  if (!iso2) return null;
  const upper = iso2.toUpperCase();
  return DIAL_COUNTRIES.find((c) => c.iso2 === upper)?.dial ?? null;
}

/** ISO code of a calling code, or null. */
export function isoForDial(dial: string | null | undefined): DialIso | null {
  if (!dial) return null;
  return DIAL_COUNTRIES.find((c) => c.dial === dial)?.iso2 ?? null;
}

/** Country of the device time zone among the countries the app serves, or null. */
export function dialFromTimeZone(timeZone?: string): string | null {
  let zone = timeZone;
  if (zone === undefined) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = undefined;
    }
  }
  return DIAL_COUNTRIES.find((c) => c.timeZone === zone)?.dial ?? null;
}

/** ASCII digits (Arabic-Indic and Extended Arabic-Indic digits mapped), leading "+" kept. */
export function cleanPhoneInput(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x30 && code <= 0x39) out += ch;
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if ((ch === '+' || code === 0xff0b) && out === '') out += '+'; // also the full-width plus
    // spaces, dashes, dots, parentheses and bidi marks are ignored
  }
  return out;
}

/**
 * E.164 form of a typed phone number, or null when it cannot be one.
 *   "+255 712 345 678", "00255712345678"  → international, `dial` is ignored
 *   "0712 345 678", "712345678" + "255"   → "+255712345678" (trunk zeros dropped)
 *   "255712345678" + "255"                → not prefixed twice when the length says the
 *                                           calling code is already there
 * A national number without a calling code (`dial` null) is not guessed.
 */
export function toPersonE164(input: string | null | undefined, dial: string | null): string | null {
  const cleaned = cleanPhoneInput(input ?? '');
  if (cleaned === '' || cleaned === '+') return null;
  let candidate: string;
  if (cleaned.startsWith('+')) {
    candidate = cleaned;
  } else if (cleaned.startsWith('00')) {
    candidate = `+${cleaned.slice(2)}`;
  } else {
    if (!dial) return null;
    const national = cleaned.replace(/^0+/, '');
    if (national === '') return null;
    const country = DIAL_COUNTRIES.find((c) => c.dial === dial);
    const alreadyPrefixed =
      country !== undefined &&
      national.startsWith(dial) &&
      national.length === dial.length + country.nationalLength;
    candidate = alreadyPrefixed ? `+${national}` : `+${dial}${national}`;
  }
  return isPersonE164(candidate) ? candidate : null;
}

/** Splits a stored E.164 number into a known calling code and the national part (edit form). */
export function splitE164(phone: string | null | undefined): {
  dial: string | null;
  national: string;
} {
  if (!phone) return { dial: null, national: '' };
  const digits = phone.replace(/^\+/, '');
  // Longest match first (all known codes have three digits today, but stay general).
  const match = [...DIAL_COUNTRIES]
    .sort((a, b) => b.dial.length - a.dial.length)
    .find((c) => digits.startsWith(c.dial));
  if (!match) return { dial: null, national: phone };
  return { dial: match.dial, national: digits.slice(match.dial.length) };
}
