/**
 * Shapes of the data written by v2 (reference/v2/src: domain.js `ProjectRepository`,
 * people.js `PersonDirectory`, photos.js, app.js `formProject()`), exactly as they sit in
 * `localStorage` or in a v2 backup file ("نسخة احتياطية" = `JSON.stringify(projects)`).
 *
 * Everything is optional and `unknown`-typed where v2 never validated the value: a backup file
 * may have been edited by hand, and v2's own validation allowed strings for numbers.
 */

/** `photos[i]` of a v2 project (photos.js). `data` is a `data:image/...;base64,` URL. */
export interface V2Photo {
  id?: unknown;
  data?: unknown;
  category?: unknown;
  caption?: unknown;
  source?: unknown;
}

/** `staff[i]` of a v2 project (app.js `collectStaff`). `salary` 0 = not entered. */
export interface V2Staff {
  name?: unknown;
  role?: unknown;
  birthDate?: unknown;
  region?: unknown;
  education?: unknown;
  graduationInstitution?: unknown;
  salary?: unknown;
  phone?: unknown;
}

export interface V2Land {
  ownership?: unknown;
  ownerName?: unknown;
  area?: unknown;
  utilization?: unknown;
  expandable?: unknown;
  notes?: unknown;
}

export interface V2Facilities {
  teacherHousing?: unknown;
  imamHousing?: unknown;
  guestHousing?: unknown;
  library?: unknown;
  quranCount?: unknown;
  quranNeed?: unknown;
  hall?: unknown;
  hallCapacity?: unknown;
  studentTransport?: unknown;
  studentsLocal?: unknown;
}

/** The seven multi-choice lists are arrays of labels (or one string with separators). */
export interface V2Community {
  branchName?: unknown;
  population?: unknown;
  muslimPercentage?: unknown;
  ibadiFamilies?: unknown;
  omaniFamilies?: unknown;
  omaniStudentPercentage?: unknown;
  ibadiStudentPercentage?: unknown;
  omaniTeacherPercentage?: unknown;
  ibadiTeacherPercentage?: unknown;
  financialCapacity?: unknown;
  daawaActivities?: unknown;
  socialFeatures?: unknown;
  livelihoods?: unknown;
  religiousIssues?: unknown;
  religiousChallenges?: unknown;
  socialChallenges?: unknown;
  proposedActivities?: unknown;
}

/** One element of `istiqama-projects-v2` / of a v2 backup file. */
export interface V2Project {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  country?: unknown;
  region?: unknown;
  locality?: unknown;
  lat?: unknown;
  lng?: unknown;
  capacity?: unknown;
  status?: unknown;
  manager?: unknown;
  phone?: unknown;
  builder?: unknown;
  donor?: unknown;
  buildDate?: unknown;
  maintenanceNotes?: unknown;
  /** Hard-coded name in v2 (brief §7.7): never migrated. */
  createdBy?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  photos?: unknown;
  /** Legacy single photo (v2 < 2.5). */
  photo?: unknown;
  staff?: unknown;
  land?: unknown;
  facilities?: unknown;
  community?: unknown;
}

/** One element of `istiqama-people-v1` (people.js). */
export interface V2Person {
  id?: unknown;
  name?: unknown;
  normalizedName?: unknown;
  roles?: unknown;
  birthDate?: unknown;
  region?: unknown;
  education?: unknown;
  graduationInstitution?: unknown;
  salary?: unknown;
  phone?: unknown;
}

export type V2SourceKind = 'v2_local' | 'v2_json';

/** What one migration run reads: the projects and (local data only) the person directory. */
export interface V2Data {
  source: V2SourceKind;
  projects: V2Project[];
  people: V2Person[];
  /** Stable hash of the input, identifies a run so that it can be resumed. */
  fingerprint: string;
  /** File name of a backup file (v2_json). */
  fileName?: string;
}

/** The two localStorage keys of v2 (also listed in src/lib/prefs.ts `LEGACY_V2_KEYS`). */
export const V2_PROJECTS_KEY = 'istiqama-projects-v2';
export const V2_PEOPLE_KEY = 'istiqama-people-v1';
