/**
 * Step 2 — the filled template goes to the `import` Edge Function, which parses it on the
 * server and stages + validates every row (nothing is written to projects yet). The limits
 * are checked on the device first so that a big file is not sent for nothing.
 */
import { useRef, useState } from 'preact/hooks';
import { fmt, locale, t } from '../i18n';
import { Button } from '../ui';
import { MAX_FILE_BYTES, importApi } from './api';
import { importErrorText } from './labels';
import type { UploadResult } from './types';

const ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type FileCheck = 'ok' | 'too_large' | 'unsupported' | 'empty';

/** Checks done before sending (the server checks everything again). */
export function checkFile(file: { name: string; size: number }): FileCheck {
  if (file.size === 0) return 'empty';
  if (file.size > MAX_FILE_BYTES) return 'too_large';
  if (!/\.(csv|xlsx)$/i.test(file.name)) return 'unsupported';
  return 'ok';
}

export interface UploadCardProps {
  online: boolean;
  onStaged: (result: UploadResult) => void;
}

export function UploadCard({ online, onStaged }: UploadCardProps) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (event: Event): void => {
    const picked = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
    setError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    const check = checkFile(picked);
    if (check !== 'ok') {
      setFile(null);
      setError(t(`import.file_${check}`, { size: fmt.bytes(MAX_FILE_BYTES) }));
      if (input.current) input.current.value = '';
      return;
    }
    setFile(picked);
  };

  const send = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importApi().upload(file, { lang: locale.value, fileName: file.name });
      setFile(null);
      if (input.current) input.current.value = '';
      onStaged(result);
    } catch (e) {
      setError(importErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card imp-step" aria-labelledby="imp-upload-title" data-testid="import-upload">
      <h2 id="imp-upload-title">
        <span class="imp-step__no" aria-hidden="true">
          2
        </span>
        {t('import.uploadTitle')}
      </h2>
      <p class="muted">{t('import.uploadHint')}</p>
      <div class="field">
        <label class="field__label" for="imp-file">
          {t('import.fileLabel')}
        </label>
        <input
          ref={input}
          id="imp-file"
          class="control imp-file"
          type="file"
          accept={ACCEPT}
          onChange={choose}
          disabled={busy}
          aria-describedby={error ? 'imp-file-error imp-file-hint' : 'imp-file-hint'}
          aria-invalid={error ? 'true' : undefined}
          data-testid="import-file"
        />
        <p class="field__hint" id="imp-file-hint">
          {t('import.fileHint', { size: fmt.bytes(MAX_FILE_BYTES), count: fmt.number(5000) })}
        </p>
        {error && (
          <p class="field__error" id="imp-file-error" role="alert" data-testid="import-file-error">
            {error}
          </p>
        )}
      </div>
      {file && (
        <p class="imp-file__chosen" data-testid="import-file-chosen">
          <bdi>{file.name}</bdi> · {fmt.bytes(file.size)}
        </p>
      )}
      {!online && <p class="muted">{t('import.offline')}</p>}
      <Button
        variant="gold"
        onClick={() => void send()}
        disabled={!file || !online}
        busy={busy}
        testId="import-upload-submit"
      >
        {busy ? t('import.uploading') : t('import.uploadSubmit')}
      </Button>
    </section>
  );
}
