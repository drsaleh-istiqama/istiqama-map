/**
 * Photo editor of the project form (docs/contracts/web.md §3.7, §5; v2 parity §5):
 *   - choose several photos at once, or take one with the camera (`capture=environment`):
 *     preview → accept / retake / cancel;
 *   - type of photo (enum.photo_category) + short description when "other";
 *   - delete (with confirmation), retake (the old photo stays until the new one is accepted),
 *     exactly one cover, at most 10 photos;
 *   - progress while compressing; `onBusyChange(true)` while compressing, while a native
 *     picker is open and while a captured photo waits for review — the form must not save
 *     (and should not close) then;
 *   - cancelling the native picker never closes the parent form: Escape is swallowed while a
 *     picker is open (the v2 bug);
 *   - offline: everything happens on the device;
 *   - leaving the form while photos are being prepared (nav bar, back button) loses nothing:
 *     the batch goes on, the finished photos are kept for their project and the next editor
 *     of that project takes them back into the form (detached.ts); reloading or closing the
 *     page meanwhile asks for confirmation.
 *
 * The editor STAGES photos (blobs stored at once, rows handed to the form through
 * `onChange`); the form's `saveProjectBundle()` writes the rows and the upload is queued then
 * (see persist.ts). Thumbnails only — the full image is shown in the camera review alone.
 */
import { computed, signal } from '@preact/signals';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { PHOTO_CATEGORIES } from '../db';
import { t } from '../i18n';
import { Button, confirm, Field, IconPhoto, Select } from '../ui';
import { compressPhoto, MAX_INPUT_BYTES, type CompressedPhoto } from './compress';
import { photoErrorKey } from './errors';
import {
  addPhotoRow,
  CAPTION_MAX_LENGTH,
  isLivePhoto,
  MAX_PHOTOS,
  remainingSlots,
  removePhotoRow,
  replacePhotoRow,
  setCover,
  updatePhotoRow,
  type PhotoCategory,
  type PhotoRow,
} from './model';
import {
  beginPhotoBatch,
  detachedPhotosOf,
  listenDetachedPhotos,
  photoBatchRunning,
  recordDetachedPhotos,
} from './detached';
import { discardStagedPhotos, stagePhoto, watchStagedPhotos } from './persist';
import { IconImages, PhotoThumb } from './PhotoThumb';
import './photos.css';

export interface PhotoEditorProps {
  projectId: string;
  /** The form's photo rows (`ProjectBundle.photos`). */
  photos: PhotoRow[];
  /** Receives the complete next list; removed stored photos are simply missing from it. */
  onChange: (photos: PhotoRow[]) => void;
  max?: number;
  /**
   * Country chosen in the form. Accepted for compatibility only: a staged photo gets its
   * storage paths from the project's FINAL country when it is saved (see persist.ts).
   */
  countryId?: string | null;
  /** True while the form must not save or close (compressing, picker open, review pending). */
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  testId?: string;
}

interface Candidate {
  photo: CompressedPhoto;
  previewUrl: string;
  /** Photo this capture replaces (retake), or null for a new photo. */
  replaceId: string | null;
}

// --- busy state shared with forms that prefer a signal over the callback -----------------
const busyEditors = signal<ReadonlySet<symbol>>(new Set());
/** True while any mounted photo editor is busy (see `onBusyChange`). */
export const photoEditorBusy = computed(() => busyEditors.value.size > 0);

function setEditorBusy(token: symbol, busy: boolean): void {
  const has = busyEditors.peek().has(token);
  if (busy === has) return;
  const next = new Set(busyEditors.peek());
  if (busy) next.add(token);
  else next.delete(token);
  busyEditors.value = next;
}

/** Delay before a closed picker stops swallowing Escape (the key event may trail the dialog). */
const PICKER_SETTLE_MS = 300;
/** Engines without the input "cancel" event: no `change` this long after refocus = cancelled. */
const PICKER_FOCUS_FALLBACK_MS = 1000;

const fileName = (file: File | Blob): string =>
  (file as File).name && (file as File).name.trim() !== '' ? (file as File).name : '—';

/** Message of a failure; `{max}` is the size limit in MB or the photo limit, by error. */
export function photoErrorText(e: unknown, maxPhotos = MAX_PHOTOS): string {
  const key = photoErrorKey(e);
  const max = key === 'photos.error_too_large' ? Math.round(MAX_INPUT_BYTES / 1048576) : maxPhotos;
  return t(key, { max });
}

export function PhotoEditor({
  projectId,
  photos,
  onChange,
  max = MAX_PHOTOS,
  onBusyChange,
  disabled = false,
  testId = 'photo-editor',
}: PhotoEditorProps) {
  const titleId = useId();
  const reviewTitleId = useId();

  // The list the next change builds on. Props can lag behind our own `onChange` calls
  // (several photos are added in one batch), so a re-render with the SAME props object never
  // rolls the list back; a new array from the parent always wins.
  const latest = useRef(photos);
  const lastProps = useRef(photos);
  if (photos !== lastProps.current) {
    lastProps.current = photos;
    latest.current = photos;
  }
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const maxRef = useRef(max);
  maxRef.current = max;
  const emit = (next: PhotoRow[]): void => {
    latest.current = next;
    onChangeRef.current(next);
  };
  /** False once unmounted: late results are then kept for the project (detached.ts). */
  const alive = useRef(true);

  const [compressing, setCompressing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [candidate, setCandidateState] = useState<Candidate | null>(null);

  const candidateRef = useRef<Candidate | null>(null);
  const replaceTarget = useRef<string | null>(null);
  const pickerRef = useRef<{ open: boolean; token: number; changed: number }>({
    open: false,
    token: 0,
    changed: -1,
  });
  const chooseInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const busyToken = useRef(Symbol('photo-editor'));

  const live = photos.filter(isLivePhoto);
  const atLimit = remainingSlots(latest.current, max) === 0;
  // Photos chosen in an earlier visit of this form may still be prepared in the background:
  // they arrive by themselves, and meanwhile the form must not save (reading subscribes).
  const background = photoBatchRunning(projectId) && !compressing;
  const blocking = compressing || background || pickerOpen || candidate !== null;
  const controlsLocked = disabled || compressing || background || candidate !== null;

  // --- busy reporting ---------------------------------------------------------------------
  const onBusyRef = useRef(onBusyChange);
  onBusyRef.current = onBusyChange;
  const reportedBusy = useRef(false);
  useEffect(() => {
    reportedBusy.current = blocking;
    onBusyRef.current?.(blocking);
    setEditorBusy(busyToken.current, blocking);
  }, [blocking]);
  // A layout effect: it runs at commit, so its cleanup runs on ANY unmount — a plain effect
  // may not have run yet when the form is left right after it opened.
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Never leave the form blocked by an editor that is gone (collapsed section, navigation).
      if (reportedBusy.current) onBusyRef.current?.(false);
      setEditorBusy(busyToken.current, false);
      const cand = candidateRef.current;
      if (cand) URL.revokeObjectURL(cand.previewUrl);
    };
  }, []);

  // --- staged photos of a restored draft: queue them once the form stores their rows -------
  useEffect(() => {
    const ids = photos.filter(isLivePhoto).map((p) => p.id);
    if (ids.length > 0) watchStagedPhotos(ids);
  }, [projectId]);

  // --- photos that finished after an earlier editor of this project was gone ---------------
  // Taken back into the form (which autosaves them with its draft); those arriving while this
  // editor is on screen come in at once. Never twice: rows already in the list are skipped.
  useEffect(() => {
    let active = true;
    const attach = (rows: PhotoRow[]): void => {
      if (!active) return;
      const known = new Set(latest.current.map((p) => p.id));
      let list = latest.current;
      let added = 0;
      const over: PhotoRow[] = [];
      for (const row of rows) {
        if (known.has(row.id)) continue;
        known.add(row.id);
        if (remainingSlots(list, maxRef.current) > 0) {
          list = addPhotoRow(list, { ...row, is_cover: false });
          added++;
        } else over.push(row);
      }
      const parts: string[] = [];
      if (added > 0) {
        emit(list);
        parts.push(t('photos.reattached', { count: added }), t('photos.saveReminder'));
      }
      if (over.length > 0) {
        parts.push(t('photos.skipped', { count: over.length, max: maxRef.current }));
        void discardStagedPhotos(over);
      }
      if (parts.length > 0) setMessage(parts.join(' '));
    };
    const stop = listenDetachedPhotos(projectId, attach);
    void detachedPhotosOf(projectId).then(attach, () => undefined);
    return () => {
      active = false;
      stop();
    };
  }, [projectId]);

  // --- Escape must not reach the form while a native picker is open (v2 bug) ---------------
  useEffect(() => {
    if (!pickerOpen) return;
    const swallow = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', swallow, true);
    return () => window.removeEventListener('keydown', swallow, true);
  }, [pickerOpen]);

  const setCandidate = (next: Candidate | null): void => {
    const previous = candidateRef.current;
    if (previous && previous !== next) URL.revokeObjectURL(previous.previewUrl);
    candidateRef.current = next;
    setCandidateState(next);
  };

  useEffect(() => {
    if (candidate) reviewRef.current?.focus();
  }, [candidate]);

  // --- native pickers -----------------------------------------------------------------------
  // `replaceTarget` is set before every camera opening (new photo → null, retake → id), so a
  // cancelled picker leaves nothing to undo: the old photo and any pending capture stay.
  const closePicker = (cancelled: boolean): void => {
    const picker = pickerRef.current;
    if (!picker.open) return;
    picker.open = false;
    window.setTimeout(() => {
      if (!pickerRef.current.open) setPickerOpen(false);
    }, PICKER_SETTLE_MS);
    if (cancelled) setMessage(t('photos.pickerCancelled'));
  };

  const openPicker = (input: HTMLInputElement | null): void => {
    if (!input) return;
    const picker = pickerRef.current;
    picker.open = true;
    picker.token++;
    const token = picker.token;
    setPickerOpen(true);
    setErrors([]);
    input.value = '';
    const onFocus = (): void => {
      window.setTimeout(() => {
        const p = pickerRef.current;
        // Silent: a slow `change` (large file copied by Android) may still follow.
        if (p.open && p.token === token && p.changed !== token) closePicker(false);
      }, PICKER_FOCUS_FALLBACK_MS);
    };
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  };

  // "cancel" is not mapped by every JSX runtime: listen natively.
  useEffect(() => {
    const onCancel = (): void => closePicker(true);
    const inputs = [chooseInput.current, cameraInput.current];
    for (const input of inputs) input?.addEventListener('cancel', onCancel);
    return () => {
      for (const input of inputs) input?.removeEventListener('cancel', onCancel);
    };
  }, []);

  const takeFiles = (input: HTMLInputElement | null): File[] => {
    pickerRef.current.changed = pickerRef.current.token;
    const files = input?.files ? [...input.files] : [];
    closePicker(files.length === 0);
    return files;
  };

  // --- adding photos --------------------------------------------------------------------------
  const addFiles = async (files: File[]): Promise<void> => {
    setErrors([]);
    const slots = remainingSlots(latest.current, max);
    if (slots <= 0) {
      setMessage(t('photos.limit', { max }));
      return;
    }
    const accepted = files.slice(0, slots);
    const skipped = files.length - accepted.length;
    const project = projectId;
    // Gone = unmounted (the form route was left) or now showing another project: the batch
    // goes on and its photos are kept for `project` (detached.ts) instead of a dead callback.
    const gone = (): boolean => !alive.current || projectRef.current !== project;
    // This batch's view of the project's photos (also counts photos kept while gone).
    let list = latest.current;
    const problems: string[] = [];
    let added = 0;
    const endBatch = beginPhotoBatch(project);
    setCompressing(true);
    try {
      for (let i = 0; i < accepted.length; i++) {
        const file = accepted[i] as File;
        if (!gone()) setProgress({ current: i + 1, total: accepted.length });
        try {
          const compressed = await compressPhoto(file);
          if (!gone()) list = latest.current;
          if (remainingSlots(list, max) <= 0) {
            problems.push(
              t('photos.fileError', { name: fileName(file), message: t('photos.limit', { max }) }),
            );
            continue;
          }
          const row = await stagePhoto(project, compressed);
          if (gone()) {
            try {
              await recordDetachedPhotos(project, [row]);
            } catch (error) {
              await discardStagedPhotos([row]).catch(() => undefined); // never orphaned
              throw error;
            }
            list = addPhotoRow(list, row);
          } else {
            list = addPhotoRow(latest.current, row);
            emit(list);
          }
          added++;
        } catch (e) {
          problems.push(
            t('photos.fileError', { name: fileName(file), message: photoErrorText(e, max) }),
          );
        }
      }
    } finally {
      endBatch();
      setCompressing(false);
      setProgress(null);
    }
    if (gone()) return; // nobody to tell; the next editor of the project says what came back
    const parts = [t('photos.added', { count: added })];
    if (added > 0) parts.push(t('photos.saveReminder'));
    if (skipped > 0) parts.push(t('photos.skipped', { count: skipped, max }));
    setMessage(parts.join(' '));
    setErrors(problems);
  };

  const onChooseChange = (): void => {
    const files = takeFiles(chooseInput.current);
    if (files.length > 0) void addFiles(files);
  };

  const onCameraChange = async (): Promise<void> => {
    const file = takeFiles(cameraInput.current)[0];
    if (!file) return;
    const replaceId = replaceTarget.current;
    setErrors([]);
    setCompressing(true);
    setProgress({ current: 1, total: 1 });
    try {
      const compressed = await compressPhoto(file);
      // A capture is only chosen once accepted: when the form was left meanwhile there is
      // nothing to keep (no blob was stored, no preview URL is created).
      if (!alive.current) return;
      setCandidate({
        photo: compressed,
        previewUrl: URL.createObjectURL(compressed.full),
        replaceId,
      });
      setMessage(t('photos.reviewHint'));
    } catch (e) {
      setErrors([t('photos.fileError', { name: fileName(file), message: photoErrorText(e, max) })]);
    } finally {
      setCompressing(false);
      setProgress(null);
    }
  };

  const indexOf = (photoId: string | null): number =>
    photoId ? latest.current.filter(isLivePhoto).findIndex((p) => p.id === photoId) + 1 : 0;

  const focusChoose = (): void => {
    chooseButton.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  };

  const accept = async (): Promise<void> => {
    const cand = candidateRef.current;
    if (!cand) return;
    const replaceId =
      cand.replaceId && latest.current.some((p) => p.id === cand.replaceId && isLivePhoto(p))
        ? cand.replaceId
        : null;
    if (!replaceId && remainingSlots(latest.current, max) <= 0) {
      setErrors([t('photos.limit', { max })]);
      return;
    }
    const position = indexOf(replaceId);
    const project = projectId;
    setCompressing(true);
    try {
      const row = await stagePhoto(project, cand.photo);
      if (!alive.current || projectRef.current !== project) {
        // Accepted, then the form was left while the blobs were being written: keep it.
        await recordDetachedPhotos(project, [row]).catch(() => discardStagedPhotos([row]));
        return;
      }
      emit(
        replaceId
          ? replacePhotoRow(latest.current, replaceId, row)
          : addPhotoRow(latest.current, row),
      );
      replaceTarget.current = null;
      setCandidate(null);
      setMessage(
        `${replaceId ? t('photos.replaced', { n: position }) : t('photos.accepted')} ${t('photos.saveReminder')}`,
      );
      // The replaced photo's blobs go only when it was never saved (a stored one is
      // soft-deleted with the form's save and its blobs with it).
      if (replaceId) await discardStagedPhotos([{ id: replaceId }]);
    } catch (e) {
      setErrors([photoErrorText(e, max)]);
    } finally {
      setCompressing(false);
    }
    focusChoose();
  };

  const retakeFromReview = (): void => {
    replaceTarget.current = candidateRef.current?.replaceId ?? null;
    openPicker(cameraInput.current);
  };

  const cancelReview = (): void => {
    replaceTarget.current = null;
    setCandidate(null);
    setMessage(t('photos.captureCancelled'));
    focusChoose();
  };

  // --- per-photo actions --------------------------------------------------------------------
  const takePhoto = (): void => {
    replaceTarget.current = null;
    openPicker(cameraInput.current);
  };

  const retake = (photoId: string): void => {
    replaceTarget.current = photoId;
    openPicker(cameraInput.current);
  };

  const remove = async (photoId: string): Promise<void> => {
    const ok = await confirm({
      title: t('photos.deleteTitle'),
      message: t('photos.deleteMessage'),
      confirmLabel: t('photos.deleteConfirm'),
      danger: true,
    });
    if (!ok) return;
    emit(removePhotoRow(latest.current, photoId));
    setMessage(t('photos.deleted'));
    await discardStagedPhotos([{ id: photoId }]);
    focusChoose();
  };

  const makeCover = (photoId: string): void => {
    const target = latest.current.find((p) => p.id === photoId);
    if (!target || target.is_cover) return;
    const position = indexOf(photoId);
    emit(setCover(latest.current, photoId));
    setMessage(t('photos.coverSet', { n: position }));
  };

  const categoryOptions = PHOTO_CATEGORIES.map((code) => ({
    value: code,
    label: t(`enum.photo_category.${code}`),
  }));

  return (
    <section
      class="photo-editor"
      aria-labelledby={titleId}
      data-testid={testId}
      data-busy={blocking ? 'true' : 'false'}
    >
      <div class="photo-editor__head">
        <h3 class="photo-editor__title" id={titleId}>
          {t('photos.title')}
        </h3>
        <span class="photo-editor__count" data-testid="photo-count">
          {t('photos.count', { count: live.length, max })}
        </span>
      </div>
      <p class="photo-editor__hint">{t('photos.hint')}</p>

      <div class="photo-editor__actions" ref={chooseButton}>
        <Button
          icon={<IconImages />}
          testId="photo-choose"
          disabled={controlsLocked || atLimit}
          onClick={() => openPicker(chooseInput.current)}
        >
          {t('photos.choose')}
        </Button>
        <Button
          icon={<IconPhoto />}
          testId="photo-camera"
          disabled={controlsLocked || atLimit}
          onClick={takePhoto}
        >
          {t('photos.camera')}
        </Button>
      </div>
      <input
        ref={chooseInput}
        class="photo-editor__input"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-testid="form-photo-input"
        disabled={disabled}
        onChange={onChooseChange}
      />
      <input
        ref={cameraInput}
        class="photo-editor__input"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="photo-camera-input"
        disabled={disabled}
        onChange={() => void onCameraChange()}
      />

      {atLimit && (
        <p class="photo-editor__limit" data-testid="photo-limit">
          {t('photos.limit', { max })}
        </p>
      )}

      {progress && (
        <div class="photo-editor__progress" data-testid="photo-progress">
          <progress
            max={progress.total}
            value={progress.current - 1}
            aria-label={t('photos.processing', progress)}
          />
          <span>{t('photos.processing', progress)}</span>
        </div>
      )}
      {background && (
        <p class="photo-editor__progress" data-testid="photo-background">
          {t('photos.background')}
        </p>
      )}

      <p class="photo-editor__status" role="status" aria-live="polite" data-testid="photo-status">
        {message}
      </p>
      {errors.length > 0 && (
        <ul class="photo-editor__errors" role="alert" data-testid="photo-errors">
          {errors.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      )}

      {candidate && (
        <div
          class="photo-review"
          ref={reviewRef}
          tabIndex={-1}
          role="group"
          aria-labelledby={reviewTitleId}
          data-testid="photo-review"
        >
          <h4 class="photo-review__title" id={reviewTitleId}>
            {t('photos.reviewTitle')}
          </h4>
          <p class="photo-review__hint">
            {candidate.replaceId && indexOf(candidate.replaceId) > 0
              ? t('photos.reviewReplaceHint', { n: indexOf(candidate.replaceId) })
              : t('photos.reviewHint')}
          </p>
          <img
            class="photo-review__image"
            src={candidate.previewUrl}
            alt={t('photos.reviewAlt')}
            data-testid="photo-review-image"
          />
          <div class="photo-review__actions">
            <Button
              variant="primary"
              testId="photo-accept"
              busy={compressing}
              onClick={() => void accept()}
            >
              {t('photos.accept')}
            </Button>
            <Button testId="photo-review-retake" disabled={compressing} onClick={retakeFromReview}>
              {t('photos.reviewRetake')}
            </Button>
            <Button
              variant="ghost"
              testId="photo-review-cancel"
              disabled={compressing}
              onClick={cancelReview}
            >
              {t('photos.reviewCancel')}
            </Button>
          </div>
          <p class="photo-review__note">{t('photos.reviewPending')}</p>
        </div>
      )}

      {live.length === 0 ? (
        <p class="photo-editor__empty" data-testid="photo-empty">
          {t('photos.empty')}
        </p>
      ) : (
        <ol class="photo-editor__list">
          {live.map((photo, index) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              label={t('photos.photoLabel', { n: index + 1, total: live.length })}
              categoryOptions={categoryOptions}
              locked={controlsLocked}
              onCategory={(category) =>
                emit(updatePhotoRow(latest.current, photo.id, { category }))
              }
              onCaption={(caption) => emit(updatePhotoRow(latest.current, photo.id, { caption }))}
              onCover={() => makeCover(photo.id)}
              onRetake={() => retake(photo.id)}
              onDelete={() => void remove(photo.id)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

interface PhotoCardProps {
  photo: PhotoRow;
  label: string;
  categoryOptions: Array<{ value: string; label: string }>;
  locked: boolean;
  onCategory: (category: PhotoCategory) => void;
  onCaption: (caption: string | null) => void;
  onCover: () => void;
  onRetake: () => void;
  onDelete: () => void;
}

function PhotoCard({
  photo,
  label,
  categoryOptions,
  locked,
  onCategory,
  onCaption,
  onCover,
  onRetake,
  onDelete,
}: PhotoCardProps) {
  const base = `photo-${photo.id}`;
  const categoryText =
    photo.category === 'unspecified' ? label : t(`enum.photo_category.${photo.category}`);
  return (
    <li
      class={photo.is_cover ? 'photo-card photo-card--cover' : 'photo-card'}
      data-testid="photo-card"
      data-photo-id={photo.id}
      data-cover={photo.is_cover ? 'true' : 'false'}
      aria-label={label}
    >
      <div class="photo-card__media">
        <PhotoThumb photo={photo} alt={t('photos.alt', { label: categoryText })} />
        {photo.is_cover && (
          <span class="badge badge--gold photo-card__badge" data-testid="photo-cover-badge">
            {t('photos.cover')}
          </span>
        )}
        {photo.upload_state !== 'uploaded' && (
          <span class="photo-card__pending">{t('photos.pendingUpload')}</span>
        )}
      </div>
      <div class="photo-card__fields">
        <Field label={t('photos.category')} htmlFor={`${base}-category`}>
          <Select
            options={categoryOptions}
            value={photo.category}
            testId="photo-category"
            disabled={locked}
            onChange={(value) => onCategory(value as PhotoCategory)}
          />
        </Field>
        {photo.category === 'other' && (
          <Field label={t('photos.caption')} htmlFor={`${base}-caption`}>
            <input
              type="text"
              class="control"
              maxLength={CAPTION_MAX_LENGTH}
              value={photo.caption ?? ''}
              placeholder={t('photos.captionPlaceholder')}
              data-testid="photo-caption"
              disabled={locked}
              onInput={(event) => {
                const text = event.currentTarget.value.slice(0, CAPTION_MAX_LENGTH);
                onCaption(text.trim() === '' ? null : text);
              }}
            />
          </Field>
        )}
      </div>
      <div class="photo-card__actions">
        <Button
          variant={photo.is_cover ? 'gold' : 'secondary'}
          testId="photo-cover"
          aria-pressed={photo.is_cover ? 'true' : 'false'}
          aria-label={t('photos.actionFor', {
            action: photo.is_cover ? t('photos.cover') : t('photos.makeCover'),
            label,
          })}
          disabled={locked}
          onClick={onCover}
        >
          {photo.is_cover ? t('photos.cover') : t('photos.makeCover')}
        </Button>
        <Button
          testId="photo-retake"
          aria-label={t('photos.actionFor', { action: t('photos.retake'), label })}
          disabled={locked}
          onClick={onRetake}
        >
          {t('photos.retake')}
        </Button>
        <Button
          variant="danger"
          testId="photo-delete"
          aria-label={t('photos.actionFor', { action: t('photos.delete'), label })}
          disabled={locked}
          onClick={onDelete}
        >
          {t('photos.delete')}
        </Button>
      </div>
    </li>
  );
}
