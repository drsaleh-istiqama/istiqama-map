/** Small display helpers shared by the picker, the directory, the card and the merge tool. */
import { fmt, locale, t } from '../i18n';

interface Names {
  name_ar?: string | null;
  name_latin?: string | null;
}

/** The name in the script of the interface first (Arabic UI: Arabic name; else Latin). */
export function primaryName(p: Names | null | undefined): string {
  if (!p) return '';
  const ar = p.name_ar?.trim() || '';
  const latin = p.name_latin?.trim() || '';
  return (locale.value === 'ar' ? ar || latin : latin || ar) || t('people.unnamed');
}

/** The other script, or '' when the person has only one name. */
export function secondaryName(p: Names | null | undefined): string {
  if (!p) return '';
  const ar = p.name_ar?.trim() || '';
  const latin = p.name_latin?.trim() || '';
  if (!ar || !latin) return '';
  return locale.value === 'ar' ? latin : ar;
}

/** Both names on one line for confirmations and toasts. */
export function fullName(p: Names | null | undefined): string {
  const second = secondaryName(p);
  return second ? `${primaryName(p)} (${second})` : primaryName(p);
}

export function NameBlock({ person, class: extra }: { person: Names; class?: string }) {
  const second = secondaryName(person);
  return (
    <span class={['pp-names', extra].filter(Boolean).join(' ')}>
      <bdi class="pp-names__primary">{primaryName(person)}</bdi>
      {second && (
        <bdi class="pp-names__secondary" dir="auto">
          {second}
        </bdi>
      )}
    </span>
  );
}

/** Phone numbers are Latin fragments: isolated LTR inside RTL text. */
export function PhoneText({
  phone,
  masked,
}: {
  phone: string | null | undefined;
  masked?: boolean;
}) {
  if (!phone) return <span class="muted">{t('people.notSet')}</span>;
  return (
    <span class="pp-phone-text">
      <span class="ltr" dir="ltr">
        {phone}
      </span>
      {masked && <span class="pp-masked">{t('people.phoneMasked')}</span>}
    </span>
  );
}

export function rolesText(roles: readonly string[]): string {
  return roles.map((r) => t(`enum.staff_role.${r}`)).join(t('people.listSeparator'));
}

/** "1 Mar 2019 — until now" */
export function datesText(start: string | null, end: string | null): string {
  return t('people.assignmentDates', {
    from: start ? fmt.date(start) : t('people.dateUnknown'),
    to: end ? fmt.date(end) : t('people.dateOpen'),
  });
}
