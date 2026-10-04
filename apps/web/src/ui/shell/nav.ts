/**
 * Navigation model of the shell (pure, unit-tested).
 *
 * Mobile bottom bar — exactly: map, projects, add (+), maintenance, reports (brief §12: the
 * v2 bar had no maintenance entry). Everything else lives in the "more" sheet. On desktop
 * both groups are listed in the sidebar. Items the user has no capability for are hidden.
 */
import type { NavId } from '../../routes';
import {
  IconAdmin,
  IconChart,
  IconChecklist,
  IconList,
  IconMap,
  IconPlus,
  IconReview,
  IconSettings,
  IconUpload,
  IconUsers,
  IconWrench,
  type IconComponent,
} from '../icons';

/** Plain snapshot of the `can.*` capability signals of `src/auth`. */
export interface Capabilities {
  write: boolean;
  review: boolean;
  seePeople: boolean;
  admin: boolean;
}

export interface NavItem {
  id: NavId;
  path: string;
  /** Translation key of the full label (sidebar, sheet, accessible name). */
  labelKey: string;
  /** Translation key of the short label under a bottom-bar icon. */
  shortLabelKey: string;
  /** Test ids fixed by docs/contracts/web.md §3.9. */
  testId: string;
  icon: IconComponent;
  group: 'primary' | 'more';
  /** Capability needed to see the item; none = every signed-in user. */
  requires?: keyof Capabilities;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'map',
    path: '/map',
    labelKey: 'nav.map',
    shortLabelKey: 'nav.map',
    testId: 'nav-map',
    icon: IconMap,
    group: 'primary',
  },
  {
    id: 'projects',
    path: '/projects',
    labelKey: 'nav.projects',
    shortLabelKey: 'nav.projectsShort',
    testId: 'nav-projects',
    icon: IconList,
    group: 'primary',
  },
  {
    id: 'add',
    path: '/projects/new',
    labelKey: 'nav.add',
    shortLabelKey: 'nav.addShort',
    testId: 'add-project',
    icon: IconPlus,
    group: 'primary',
    requires: 'write',
  },
  {
    id: 'maintenance',
    path: '/maintenance',
    labelKey: 'nav.maintenance',
    shortLabelKey: 'nav.maintenance',
    testId: 'nav-maintenance',
    icon: IconWrench,
    group: 'primary',
  },
  {
    id: 'reports',
    path: '/reports',
    labelKey: 'nav.reports',
    shortLabelKey: 'nav.reports',
    testId: 'nav-reports',
    icon: IconChart,
    group: 'primary',
  },
  {
    id: 'incomplete',
    path: '/incomplete',
    labelKey: 'nav.incomplete',
    shortLabelKey: 'nav.incomplete',
    testId: 'nav-incomplete',
    icon: IconChecklist,
    group: 'more',
    requires: 'write',
  },
  {
    id: 'review',
    path: '/review',
    labelKey: 'nav.review',
    shortLabelKey: 'nav.review',
    testId: 'nav-review',
    icon: IconReview,
    group: 'more',
    requires: 'review',
  },
  {
    id: 'people',
    path: '/people',
    labelKey: 'nav.people',
    shortLabelKey: 'nav.people',
    testId: 'nav-people',
    icon: IconUsers,
    group: 'more',
    requires: 'seePeople',
  },
  {
    id: 'import',
    path: '/import',
    labelKey: 'nav.import',
    shortLabelKey: 'nav.import',
    testId: 'nav-import',
    icon: IconUpload,
    group: 'more',
    requires: 'write',
  },
  {
    id: 'admin',
    path: '/admin',
    labelKey: 'nav.admin',
    shortLabelKey: 'nav.admin',
    testId: 'nav-admin',
    icon: IconAdmin,
    group: 'more',
    requires: 'admin',
  },
  {
    id: 'settings',
    path: '/settings',
    labelKey: 'nav.settings',
    shortLabelKey: 'nav.settings',
    testId: 'nav-settings',
    icon: IconSettings,
    group: 'more',
  },
];

export interface VisibleNav {
  /** Bottom bar on phones. */
  primary: NavItem[];
  /** "More" sheet on phones. */
  more: NavItem[];
}

export function visibleNav(caps: Capabilities, items: readonly NavItem[] = NAV_ITEMS): VisibleNav {
  const allowed = items.filter((item) => !item.requires || caps[item.requires]);
  return {
    primary: allowed.filter((item) => item.group === 'primary'),
    more: allowed.filter((item) => item.group === 'more'),
  };
}
