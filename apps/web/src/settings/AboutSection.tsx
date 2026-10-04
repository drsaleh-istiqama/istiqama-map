import { deviceId } from '../auth';
import { env } from '../env';
import { fmt, t } from '../i18n';
import { Button, toast } from '../ui';
import { serverEnvironment } from '../ui/appSettings';
import { clearRecentErrors, recentErrors, type ErrorEntry } from '../ui/monitoring';
import { APP_VERSION } from '../version';

const ENVIRONMENT_KEYS: Record<string, string> = {
  development: 'settings.envDevelopment',
  staging: 'settings.envStaging',
  production: 'settings.envProduction',
};

function environmentLabel(name: string): string {
  const key = ENVIRONMENT_KEYS[name];
  return key ? t(key) : name;
}

/** Plain-text diagnostics a field worker can send to support (already scrubbed of personal data). */
export function diagnosticsText(
  version: string,
  environment: string,
  device: string,
  errors: readonly ErrorEntry[],
): string {
  const lines = [
    `version: ${version}`,
    `environment: ${environment}`,
    `device: ${device}`,
    `errors: ${errors.length}`,
  ];
  for (const entry of errors)
    lines.push(`${entry.at} [${entry.source}] x${entry.count} ${entry.message}`);
  return lines.join('\n');
}

/** Version, environment, device id and the last errors recorded on this device. */
export function AboutSection() {
  const errors = recentErrors.value;
  const device = deviceId();
  const environment = serverEnvironment.value ?? env.appEnv;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        diagnosticsText(APP_VERSION, environment, device, errors),
      );
      toast(t('settings.aboutCopied'), 'success');
    } catch {
      toast(t('settings.aboutCopyFailed'), 'error');
    }
  };

  return (
    <section class="card" aria-labelledby="settings-about">
      <h2 id="settings-about">{t('settings.aboutTitle')}</h2>
      <dl class="kv">
        <dt>{t('settings.aboutVersion')}</dt>
        <dd>
          <span class="ltr mono" data-testid="about-version">
            {APP_VERSION}
          </span>
        </dd>
        <dt>{t('settings.aboutEnvironment')}</dt>
        <dd data-testid="about-environment">{environmentLabel(environment)}</dd>
        <dt>{t('settings.aboutDevice')}</dt>
        <dd>
          <span class="ltr mono" data-testid="about-device">
            {device}
          </span>
        </dd>
      </dl>

      <h3 class="about__errors-title">{t('settings.aboutErrors')}</h3>
      {errors.length === 0 ? (
        <p class="muted" data-testid="about-no-errors">
          {t('settings.aboutNoErrors')}
        </p>
      ) : (
        <ol class="about__errors" data-testid="about-errors">
          {[...errors].reverse().map((entry) => (
            <li key={`${entry.at}|${entry.message}`}>
              <span class="muted">
                {fmt.dateTime(entry.at)}
                {entry.count > 1 && (
                  <>
                    {' '}
                    <span class="ltr">×{entry.count}</span>
                  </>
                )}
              </span>
              <span class="ltr mono about__error-text">{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
      <div class="row">
        <Button size="sm" testId="about-copy" onClick={() => void copy()}>
          {t('settings.aboutCopy')}
        </Button>
        {errors.length > 0 && (
          <Button size="sm" variant="ghost" testId="about-clear" onClick={clearRecentErrors}>
            {t('settings.aboutClear')}
          </Button>
        )}
      </div>
    </section>
  );
}
