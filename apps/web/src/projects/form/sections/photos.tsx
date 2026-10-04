/** Step 6 (brief §7.1): photos — the shared `<PhotoEditor>` of `src/photos` (max 10, one cover). */
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../../i18n';
import { getNumberSetting } from '../../../db';
import { Spinner } from '../../../ui';
import { useForm } from '../context';
import { isLive } from '../model';
import { loadPhotoEditor, type PhotoEditorProps } from '../peers';

export function PhotosSection() {
  const { draft, api, errors } = useForm();
  const [Editor, setEditor] = useState<ComponentType<PhotoEditorProps> | null | undefined>(
    undefined,
  );
  const [max, setMax] = useState(10);

  useEffect(() => {
    let alive = true;
    void loadPhotoEditor().then((c) => alive && setEditor(() => c));
    void getNumberSetting('photos.max_per_project', 10, 1, 10).then((n) => alive && setMax(n));
    return () => {
      alive = false;
    };
  }, []);

  const error = errors.photos;
  return (
    <section class="pf-step pf-photos" aria-labelledby="pf-photos-title" id="pf-photos">
      <h3 class="field__label" id="pf-photos-title">
        {t('form.photos')}
      </h3>
      {Editor === undefined && <Spinner size={20} />}
      {Editor === null && (
        <p class="muted pf-note" data-testid="form-photos-unavailable">
          {t('form.photosUnavailable')}
        </p>
      )}
      {Editor && (
        <Editor
          projectId={draft.projectId}
          photos={draft.working.photos.filter(isLive)}
          max={max}
          countryId={draft.working.project.country_id}
          onBusyChange={(busy) => api.setPhotosBusy(busy)}
          onChange={(photos) => api.setPhotos(photos)}
        />
      )}
      {error && (
        <p class="field__error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}
