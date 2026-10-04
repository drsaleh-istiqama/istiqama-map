/**
 * E.164 helper for phone sign-in. The seven countries of brief §0 are offered as prefixes on the
 * login screen (the country table itself cannot be read before sign-in); any other number can
 * still be typed in full international form (+… or 00…).
 */
export interface DialCountry {
  iso2: 'TZ' | 'KE' | 'UG' | 'RW' | 'BI' | 'MZ' | 'OM';
  /** Country calling code without "+". */
  dial: string;
  /** Usual length of the national number (without the trunk "0"); used for the example only. */
  nationalLength: number;
  /** IANA time zone used to preselect the country. */
  timeZone: string;
}

export const DIAL_COUNTRIES: readonly DialCountry[] = [
  { iso2: 'TZ', dial: '255', nationalLength: 9, timeZone: 'Africa/Dar_es_Salaam' },
  { iso2: 'KE', dial: '254', nationalLength: 9, timeZone: 'Africa/Nairobi' },
  { iso2: 'UG', dial: '256', nationalLength: 9, timeZone: 'Africa/Kampala' },
  { iso2: 'RW', dial: '250', nationalLength: 9, timeZone: 'Africa/Kigali' },
  { iso2: 'BI', dial: '257', nationalLength: 8, timeZone: 'Africa/Bujumbura' },
  { iso2: 'MZ', dial: '258', nationalLength: 9, timeZone: 'Africa/Maputo' },
  { iso2: 'OM', dial: '968', nationalLength: 8, timeZone: 'Asia/Muscat' },
];

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Maps Arabic-Indic and Extended Arabic-Indic digits to ASCII and drops separators. */
function cleanDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x30 && code <= 0x39) out += ch;
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (ch === '+' && out === '') out += '+';
    // spaces, dashes, dots, parentheses and bidi marks are ignored
  }
  return out;
}

export function isE164(phone: string): boolean {
  return E164.test(phone);
}

/**
 * Builds an E.164 number from what the user typed.
 * - "+255 712 345 678" / "00255712345678" → taken as international, the prefix is ignored;
 * - "0712 345 678" / "712345678" with prefix "255" → "+255712345678";
 * - a national number that already starts with the selected calling code and is too long to be
 *   national ("255712345678") is not prefixed twice.
 * Returns null when the result is not a plausible E.164 number.
 */
export function toE164(input: string, dial: string): string | null {
  const cleaned = cleanDigits(input);
  if (cleaned === '' || cleaned === '+') return null;
  let candidate: string;
  if (cleaned.startsWith('+')) {
    candidate = cleaned;
  } else if (cleaned.startsWith('00')) {
    candidate = `+${cleaned.slice(2)}`;
  } else {
    const country = DIAL_COUNTRIES.find((c) => c.dial === dial);
    const national = cleaned.replace(/^0+/, '');
    const alreadyPrefixed =
      national.startsWith(dial) &&
      country !== undefined &&
      national.length === dial.length + country.nationalLength;
    candidate = alreadyPrefixed ? `+${national}` : `+${dial}${national}`;
  }
  return isE164(candidate) ? candidate : null;
}

/** Best guess of the user's country from the device time zone (falls back to the first entry). */
export function guessDialCountry(timeZone?: string): DialCountry {
  let zone = timeZone;
  if (zone === undefined) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = undefined;
    }
  }
  return DIAL_COUNTRIES.find((c) => c.timeZone === zone) ?? DIAL_COUNTRIES[0]!;
}

/** Example national number for the placeholder, e.g. "712 345 678". */
export function exampleNational(country: DialCountry): string {
  const digits = '712345678'.slice(0, country.nationalLength);
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
