/**
 * Light helpers about the v2 data of this device (no database, no runner): whether the two
 * v2 keys exist and what they hold. Used by the first-run prompt on every screen.
 */
import { signal } from '@preact/signals';
import { hasLegacyV2, readLegacyV2, type LegacyV2Key } from '../lib/prefs';
import { readV2Local, type V2LocalState } from './v2read';
import { V2_PEOPLE_KEY, V2_PROJECTS_KEY } from './v2types';

/**
 * Bumped whenever the migration state of this device may have changed (a run ended, keys were
 * removed, a run was finalized in the background): views that show the offer re-read it.
 */
export const v2Changed = signal(0);

export function notifyV2Changed(): void {
  v2Changed.value++;
}

/** Cheap: checks the key names only (the values may be megabytes of photos). */
export function deviceHasV2Keys(): boolean {
  return hasLegacyV2(V2_PROJECTS_KEY as LegacyV2Key) || hasLegacyV2(V2_PEOPLE_KEY as LegacyV2Key);
}

/** Parses the v2 keys of this device. */
export function readDeviceV2(): V2LocalState {
  return readV2Local((key) => readLegacyV2(key as LegacyV2Key));
}

export interface DeviceV2Summary {
  projects: number;
  people: number;
  fingerprint: string;
  /** Keys present but unreadable (left alone). */
  unreadable: number;
}

export function deviceV2Summary(): DeviceV2Summary | null {
  if (!deviceHasV2Keys()) return null;
  const state = readDeviceV2();
  if (!state.data) return null;
  return {
    projects: state.data.projects.length,
    people: state.data.people.length,
    fingerprint: state.data.fingerprint,
    unreadable: state.unreadable.length,
  };
}
