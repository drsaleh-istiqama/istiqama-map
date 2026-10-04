import { useState } from 'preact/hooks';
import { me, supabase } from '../auth';
import { locale, setLocale, t, type Locale } from '../i18n';
import { toast } from '../ui';

/** Each language is named in its own language, whatever the interface language is. */
const LANGUAGES: ReadonlyArray<{ code: Locale; labelKey: string }> = [
  { code: 'ar', labelKey: 'settings.langAr' },
  { code: 'sw', labelKey: 'settings.langSw' },
  { code: 'en', labelKey: 'settings.langEn' },
];

/** Best effort: remember the choice in the user's profile so other devices start in it too. */
async function saveToProfile(language: Locale): Promise<void> {
  const userId = (me.value as { user_id?: string } | null)?.user_id;
  if (!userId || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  try {
    await supabase.from('profiles').update({ preferred_language: language }).eq('id', userId);
  } catch {
    // The choice is already stored on this device; the profile catches up another time.
  }
}

export function LanguageSection() {
  const [switching, setSwitching] = useState<Locale | null>(null);
  const current = locale.value;

  const choose = async (language: Locale): Promise<void> => {
    if (language === current || switching) return;
    setSwitching(language);
    try {
      await setLocale(language);
      void saveToProfile(language);
    } catch {
      // The dictionary chunk is not on the device and the network is unreachable.
      toast(t('settings.languageFailed'), 'error');
    } finally {
      setSwitching(null);
    }
  };

  return (
    <section class="card" aria-labelledby="settings-language">
      <h2 id="settings-language">{t('settings.languageTitle')}</h2>
      <div class="chips" role="group" aria-labelledby="settings-language">
        {LANGUAGES.map(({ code, labelKey }) => (
          <button
            key={code}
            type="button"
            class={code === current ? 'chip chip--on' : 'chip'}
            lang={code}
            aria-pressed={code === current ? 'true' : 'false'}
            aria-busy={switching === code ? 'true' : undefined}
            data-testid={`lang-${code}`}
            onClick={() => void choose(code)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <p class="field__hint">{t('settings.languageHint')}</p>
    </section>
  );
}
