/**
 * Card of the project tapped on the map (v2 parity 1.4): name, type, status, area, capacity,
 * read from the local database (brief §5: < 300 ms). For a project that is not on the device
 * (viewers, other branches) the tile attributes are shown. "Details" opens the details page.
 *
 * Phone layout: the card is a bottom sheet whose main action stays on screen — only the facts
 * scroll when the card is short of room — and the map keeps the project above it (`elementRef`
 * gives the page the element, which MapView measures as a cover). There it also covers the
 * map's attribution control, so it carries the basemap attribution (ODbL) itself.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt, pickName, t } from '../i18n';
import { navigate } from '../routes';
import { Badge, Button, IconClose, type BadgeTone } from '../ui';
import { BASEMAP_ATTRIBUTION } from './config';
import { projectName, typeColor } from './projectFormat';
import { projectSummary, type ProjectSummary } from './queries';

const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'active',
  maintenance: 'maintenance',
  building: 'building',
  inactive: 'inactive',
};

export interface SelectedProject {
  id: string;
  /** Attributes of the tapped feature (fallback when the project is not on the device). */
  properties?: Record<string, unknown>;
}

function fromProperties(id: string, p: Record<string, unknown> = {}): ProjectSummary {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    id,
    code: str(p.code),
    name_ar: str(p.name_ar) ?? '',
    name_latin: str(p.name_latin),
    type: str(p.type) ?? 'mosque',
    status: str(p.status) ?? 'active',
    record_state: str(p.record_state) ?? 'approved',
    capacity: typeof p.capacity === 'number' ? p.capacity : null,
    lon: null,
    lat: null,
    area: null,
    dirty: false,
    local: false,
  };
}

interface Props {
  selected: SelectedProject;
  onClose: () => void;
  onLoaded?: (summary: ProjectSummary) => void;
  /** The card element while it is on screen (null otherwise). */
  elementRef?: (element: HTMLElement | null) => void;
}

export function SelectedProjectCard({ selected, onClose, onLoaded, elementRef }: Props) {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let alive = true;
    // The previous project stays on the card until the next one is read (a few ms): the card
    // does not vanish and come back, so the map does not move twice.
    void projectSummary(selected.id).then((local) => {
      if (!alive) return;
      const value = local ?? fromProperties(selected.id, selected.properties);
      setSummary(value);
      onLoaded?.(value);
    });
    return () => {
      alive = false;
    };
  }, [selected.id]);

  useEffect(() => {
    if (summary) heading.current?.focus();
  }, [summary?.id]);

  if (!summary) return null;
  const name = projectName(summary) || t('map.unnamed');
  return (
    <aside
      ref={elementRef}
      class="mapcard"
      aria-labelledby="mapcard-title"
      aria-busy={summary.id !== selected.id ? 'true' : undefined}
      data-testid="map-project-card"
      data-id={summary.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header class="mapcard__head">
        <span class="mapcard__dot" style={{ backgroundColor: typeColor(summary) }} />
        <h2 id="mapcard-title" class="mapcard__title" tabIndex={-1} ref={heading}>
          {name}
        </h2>
        <button
          type="button"
          class="icon-btn"
          aria-label={t('map.closeCard')}
          data-testid="map-project-close"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </header>
      <div class="mapcard__body">
        <div class="mapcard__badges">
          <Badge tone={STATUS_TONE[summary.status] ?? 'neutral'}>
            {t(`enum.project_status.${summary.status}`)}
          </Badge>
          <Badge>{t(`enum.project_type.${summary.type}`)}</Badge>
          {summary.record_state !== 'approved' && (
            <Badge tone="info">{t(`enum.record_state.${summary.record_state}`)}</Badge>
          )}
          {summary.dirty && <Badge tone="gold">{t('map.notUploaded')}</Badge>}
        </div>
        <dl class="kv mapcard__facts">
          {summary.code && (
            <div>
              <dt>{t('map.code')}</dt>
              <dd>
                <bdi dir="ltr" class="ltr">
                  {summary.code}
                </bdi>
              </dd>
            </div>
          )}
          {summary.area && (
            <div>
              <dt>{t('map.area')}</dt>
              <dd>{pickName(summary.area)}</dd>
            </div>
          )}
          {summary.capacity !== null && (
            <div>
              <dt>{t('map.capacity')}</dt>
              <dd>{fmt.number(summary.capacity)}</dd>
            </div>
          )}
        </dl>
      </div>
      <div class="mapcard__actions">
        <Button
          variant="primary"
          testId="map-project-open"
          onClick={() => navigate(`/projects/${encodeURIComponent(summary.id)}`)}
        >
          {t('map.openDetails')}
        </Button>
        {!summary.local && <p class="field__hint">{t('map.notOnDevice')}</p>}
      </div>
      <p class="mapcard__attrib" data-testid="map-card-attribution">
        <bdi dir="ltr" lang="en">
          {BASEMAP_ATTRIBUTION}
        </bdi>
      </p>
    </aside>
  );
}
