/**
 * Public API of the photo module (docs/contracts/web.md §3.7 and §5). Other modules import
 * from `src/photos` only. Everything here is loaded with the feature chunks that use it
 * (project form, details page) — never by the shell.
 *
 * Contract
 *   compressPhoto(file)                 → full (≤1600 px, q0.8) + thumb (≤400 px), WebP or JPEG,
 *                                          no EXIF, capture time read from the original
 *   addPhoto(projectId, file, meta?)    → compress → photo_blobs → mutate() → enqueuePhotoUpload()
 *   photoUrl(photo, kind)               → local blob URL first, else thumbnail download /
 *                                          short-lived signed URL
 *   <PhotoEditor projectId photos onChange max={10} />
 *
 * Integration notes for the project form (the editor stages, the form saves):
 *   - pass `bundle.photos` and store what `onChange` returns in the bundle;
 *   - keep "save" disabled (and Esc / cancel guarded) while `onBusyChange(true)` /
 *     `photoEditorBusy.value`;
 *   - after `await saveProjectBundle(bundle)` call `await queuePhotoUploads(bundle.photos)`
 *     (staged photos are also queued automatically once their rows are stored);
 *   - when the user confirms discarding a NEW, never-saved form, call
 *     `discardStagedPhotos(bundle.photos)` to free the blobs;
 *   - leaving the form while photos are being prepared loses nothing: the photos finishing
 *     afterwards are kept for the project and the next `<PhotoEditor projectId>` of that
 *     project hands them to `onChange` (detached.ts); the shell's start-up
 *     `reconcilePhotoUploads()` frees those no form can reach any more. A router guard may
 *     still ask before leaving while `photoEditorBusy.value` is true;
 *   - staged photos carry no storage paths: the project's final country decides them on save
 *     (server) and upload (queue), so `countryId` is no longer needed.
 */
export { compressPhoto, canEncodeWebp, type CompressedPhoto, type PhotoMime } from './compress';
export { readTakenAt } from './exif';
export { PhotoError, isPhotoError, photoErrorKey, type PhotoErrorCode } from './errors';
export {
  addPhoto,
  discardDetachedPhotos,
  discardStagedPhotos,
  queuePhotoUploads,
  reconcilePhotoUploads,
  stagePhoto,
  sweepDetachedPhotos,
  type StageOptions,
} from './persist';
export { activePhotoBatches, photoBatchRunning } from './detached';
export {
  photoUrl,
  acquirePhotoUrl,
  releasePhotoUrl,
  revokePhotoUrls,
  clearPhotoUrls,
  type PhotoKind,
} from './urls';
export { usePhotoUrl, type PhotoUrlState, type PhotoUrlStatus } from './usePhotoUrl';
export {
  MAX_PHOTOS,
  isLivePhoto,
  livePhotos,
  setCover,
  storagePaths,
  withSingleCover,
  type PhotoRow,
} from './model';
export { PhotoEditor, photoEditorBusy, photoErrorText, type PhotoEditorProps } from './PhotoEditor';
export { Gallery, photoCaption, type GalleryProps } from './Gallery';
export { PhotoThumb, type PhotoThumbProps } from './PhotoThumb';
