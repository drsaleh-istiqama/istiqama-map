/** Small display helpers shared by the map's project card and the legend colours. */
import { locale } from '../i18n';
import { MAINTENANCE_COLOR, TYPE_COLORS } from './layers';

/** Arabic name in Arabic, the Latin name otherwise (falling back to whichever exists). */
export function projectName(p: { name_ar: string; name_latin: string | null }): string {
  return locale.value === 'ar' ? p.name_ar || p.name_latin || '' : p.name_latin || p.name_ar;
}

/** Marker colour of a project: maintenance first, then the type (v2 legend). */
export function typeColor(p: { type: string; status: string }): string {
  if (p.status === 'maintenance') return MAINTENANCE_COLOR;
  return TYPE_COLORS[p.type as keyof typeof TYPE_COLORS] ?? '#0f2545';
}
