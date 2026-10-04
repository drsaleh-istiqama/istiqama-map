import type { ProjectListItem } from '../db';
import { fmt, pickName, t } from '../i18n';
import { CoverThumb } from './CoverThumb';
import { RecordStateBadge, StatusBadge, TypeIcon } from './labels';

/** Fixed height of a register row (the virtual list needs one). */
export const PROJECT_ROW_HEIGHT = 96;

/** "Village · District" in the interface language; empty when the project has no place yet. */
export function placeOf(item: ProjectListItem): string {
  const locality = pickName({
    name_ar: item.locality_name_ar,
    name_latin: item.locality_name_latin,
  });
  const area = pickName({
    name_ar: item.area_name_ar,
    name_en: item.area_name_en,
    name_sw: item.area_name_sw,
  });
  return [locality, area].filter((s) => s !== '').join(' · ');
}

/** Sync markers of a row: unsynced work, a field conflict, a rejected operation. */
export function SyncFlags({
  dirty,
  conflict,
  failed,
}: {
  dirty: boolean;
  conflict: boolean;
  failed: boolean;
}) {
  if (!dirty && !conflict && !failed) return null;
  return (
    <span class="pflags">
      {failed && (
        <span
          class="pflag pflag--failed"
          data-testid="flag-failed"
          title={t('projects.flagFailed')}
        >
          <span aria-hidden="true">!</span>
          <span class="sr-only">{t('projects.flagFailed')}</span>
        </span>
      )}
      {conflict && (
        <span
          class="pflag pflag--conflict"
          data-testid="flag-conflict"
          title={t('projects.flagConflict')}
        >
          <span aria-hidden="true">⇄</span>
          <span class="sr-only">{t('projects.flagConflict')}</span>
        </span>
      )}
      {dirty && !failed && (
        <span
          class="pflag pflag--dirty"
          data-testid="flag-unsynced"
          title={t('projects.flagUnsynced')}
        >
          <span aria-hidden="true">↑</span>
          <span class="sr-only">{t('projects.flagUnsynced')}</span>
        </span>
      )}
    </span>
  );
}

/**
 * One register row: type icon, name, place, status, record state, completeness, sync markers,
 * and the cover photo's thumbnail when the project has one (brief §6).
 */
export function ProjectCard({ item }: { item: ProjectListItem }) {
  const name = pickName(item) || item.code || '';
  const place = placeOf(item);
  return (
    <div class="pcard" data-testid="project-row" data-id={item.id}>
      <span class={`pcard__icon pcard__icon--${item.status}`}>
        <TypeIcon type={item.type} size={26} labelled />
      </span>
      <div class="pcard__body">
        <div class="pcard__title">
          <bdi class="pcard__name">{name}</bdi>
          {item.code && (
            <span class="pcard__code ltr" dir="ltr">
              {item.code}
            </span>
          )}
        </div>
        <div class="pcard__place">{place || t('projects.noPlace')}</div>
        <div class="pcard__meta">
          <StatusBadge status={item.status} />
          <RecordStateBadge state={item.record_state} />
          <span class="pcard__cmp" title={t('projects.completenessTitle')}>
            {t('projects.completenessShort', { value: fmt.percent(item.completeness) })}
          </span>
          <SyncFlags dirty={item.dirty} conflict={item.conflict} failed={item.failed} />
        </div>
      </div>
      <CoverThumb photoId={item.cover_photo_id} class="pcard__thumb" />
    </div>
  );
}
