/**
 * Shared project labels (docs/contracts/web.md §5): used by the form, the details page, the
 * register list, map popups and reports. Enumerated values always come from the generated
 * `enum.*` dictionary (never retyped here).
 *
 * The file is `.ts` (no JSX) so that it can be imported from plain modules; components are
 * built with `h()`.
 */
import { h, type ComponentChildren } from 'preact';
import { Badge, type BadgeTone } from '../ui';
import { hasTranslation, t } from '../i18n';
import {
  PROJECT_STATUSES,
  PROJECT_TYPES,
  RECORD_STATES,
  type ProjectStatus,
  type ProjectType,
  type RecordState,
} from '../db';

/** Translates `enum.<key>.<code>`; an unknown code is shown as is (never a raw key). */
export function enumLabel(key: string, code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return '';
  const k = `enum.${key}.${code}`;
  return hasTranslation(k) ? t(k) : code;
}

export function typeLabel(code: string | null | undefined): string {
  return enumLabel('project_type', code);
}

export function statusLabel(code: string | null | undefined): string {
  return enumLabel('project_status', code);
}

export function recordStateLabel(code: string | null | undefined): string {
  return enumLabel('record_state', code);
}

export function isProjectType(code: unknown): code is ProjectType {
  return typeof code === 'string' && (PROJECT_TYPES as readonly string[]).includes(code);
}

export function isProjectStatus(code: unknown): code is ProjectStatus {
  return typeof code === 'string' && (PROJECT_STATUSES as readonly string[]).includes(code);
}

export function isRecordState(code: unknown): code is RecordState {
  return typeof code === 'string' && (RECORD_STATES as readonly string[]).includes(code);
}

/** Badge tone of a project status (contract colours: active, maintenance, building, inactive). */
export function statusTone(code: string | null | undefined): BadgeTone {
  return isProjectStatus(code) ? code : 'neutral';
}

const RECORD_STATE_TONES: Record<RecordState, BadgeTone> = {
  draft: 'neutral',
  submitted: 'info',
  approved: 'success',
  returned: 'warning',
};

export function recordStateTone(code: string | null | undefined): BadgeTone {
  return isRecordState(code) ? RECORD_STATE_TONES[code] : 'neutral';
}

/** Status colours from the contract (map markers, legends, charts). */
export const STATUS_COLORS: Record<ProjectStatus, string> = {
  active: '#1f7a4d',
  maintenance: '#b54708',
  building: '#175cd3',
  inactive: '#667085',
};

export interface StatusBadgeProps {
  status: string | null | undefined;
  testId?: string;
}

/** Coloured project status badge (`data-status` = the code). */
export function StatusBadge({ status, testId }: StatusBadgeProps) {
  return h(
    'span',
    { class: 'status-badge', 'data-status': status ?? '' },
    h(Badge, { tone: statusTone(status), testId, children: statusLabel(status) }),
  );
}

export interface RecordStateBadgeProps {
  state: string | null | undefined;
  testId?: string;
}

export function RecordStateBadge({ state, testId }: RecordStateBadgeProps) {
  return h(Badge, { tone: recordStateTone(state), testId, children: recordStateLabel(state) });
}

export interface TypeIconProps {
  type: string | null | undefined;
  size?: number;
  /** When set, the icon is announced with the translated type; otherwise it is decorative. */
  labelled?: boolean;
  class?: string;
}

function svg(size: number, cls: string, label: string | null, children: ComponentChildren) {
  return h(
    'svg',
    {
      class: cls,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      focusable: 'false',
      ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }),
    },
    children,
  );
}

/** Dome + minaret. */
function mosqueShapes() {
  return [
    h('path', { key: 'd', d: 'M6 20v-6a6 6 0 0 1 12 0v6' }),
    h('path', { key: 'c', d: 'M12 8V5' }),
    h('path', { key: 'm', d: 'M3 20V11l1-2 1 2v9' }),
    h('path', { key: 'b', d: 'M2 20h20' }),
    h('path', { key: 'g', d: 'M10.5 20v-3a1.5 1.5 0 0 1 3 0v3' }),
  ];
}

/** Open book. */
function schoolShapes() {
  return [
    h('path', { key: 'l', d: 'M3 5.5C5.5 4.5 8.5 4.5 12 6.5v13c-3.5-2-6.5-2-9-1Z' }),
    h('path', { key: 'r', d: 'M21 5.5c-2.5-1-5.5-1-9 1v13c3.5-2 6.5-2 9-1Z' }),
  ];
}

/** Small dome over an open book. */
function combinedShapes() {
  return [
    h('path', { key: 'd', d: 'M8 10a4 4 0 0 1 8 0' }),
    h('path', { key: 'c', d: 'M12 6V3.5' }),
    h('path', { key: 'l', d: 'M3 13c2.5-1 5.5-1 9 1v7c-3.5-2-6.5-2-9-1Z' }),
    h('path', { key: 'r', d: 'M21 13c-2.5-1-5.5-1-9 1v7c3.5-2 6.5-2 9-1Z' }),
  ];
}

/** Line icon per project type (`currentColor`). Unknown types get a neutral pin. */
export function TypeIcon({ type, size = 20, labelled = false, class: cls }: TypeIconProps) {
  const label = labelled ? typeLabel(type) || null : null;
  const className = `type-icon type-icon--${isProjectType(type) ? type : 'unknown'}${cls ? ` ${cls}` : ''}`;
  switch (type) {
    case 'mosque':
      return svg(size, className, label, mosqueShapes());
    case 'school':
      return svg(size, className, label, schoolShapes());
    case 'combined':
      return svg(size, className, label, combinedShapes());
    default:
      return svg(size, className, label, [
        h('path', { key: 'p', d: 'M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Z' }),
        h('circle', { key: 'c', cx: 12, cy: 11, r: 2 }),
      ]);
  }
}
