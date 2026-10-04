/**
 * Inline SVG icons (no icon font, no external requests). Simple original line drawings on a
 * 24 × 24 grid; they inherit `currentColor` and are hidden from assistive technology —
 * the control that contains an icon carries the accessible name.
 */
import type { ComponentChildren } from 'preact';

export interface IconProps {
  size?: number;
  class?: string;
}

export type IconComponent = (props: IconProps) => ComponentChildren;

function Svg({
  size = 24,
  class: className,
  children,
}: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      class={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconMap: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.400 12 21 12 21z" />
    <circle cx="12" cy="10.500" r="2" />
  </Svg>
);

export const IconList: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  </Svg>
);

export const IconPlus: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconWrench: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M14.500 6.500a4 4 0 0 0-5.300 5.300L4 17v3h3l5.200-5.200a4 4 0 0 0 5.300-5.300l-2.500 2.500-2-2 2.500-2.500z" />
  </Svg>
);

export const IconChart: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 20h16" />
    <path d="M7 20v-7M12 20V5M17 20v-10" />
  </Svg>
);

export const IconMore: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const IconChecklist: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 6l1.500 1.500L8 5M4 12l1.500 1.500L8 11M4 18l1.500 1.500L8 17" />
    <path d="M11 6h9M11 12h9M11 18h9" />
  </Svg>
);

export const IconReview: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 3l7 3v6c0 4.500-3 7.500-7 9-4-1.500-7-4.500-7-9V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);

export const IconUsers: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20c0-3.300 2.700-6 6-6s6 2.700 6 6" />
    <path d="M16 5.200a3 3 0 0 1 0 5.600M17.500 14.300c2 .800 3.500 2.900 3.500 5.700" />
  </Svg>
);

export const IconUpload: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Svg>
);

export const IconDownload: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Svg>
);

export const IconAdmin: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="7" rx="1" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
    <rect x="13" y="13" width="7" height="7" rx="1" />
  </Svg>
);

export const IconSettings: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);

export const IconSync: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 0 0-14-5.300L4 9" />
    <path d="M4 4v5h5" />
    <path d="M4 12a8 8 0 0 0 14 5.300L20 15" />
    <path d="M20 20v-5h-5" />
  </Svg>
);

export const IconOffline: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M7 18h10a4 4 0 0 0 1.500-7.700A6 6 0 0 0 8.300 7.600" />
    <path d="M6 9.500A4.500 4.500 0 0 0 7 18" />
    <path d="M4 4l16 16" />
  </Svg>
);

export const IconOnline: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M7 18h10a4 4 0 0 0 .700-7.900 6 6 0 0 0-11.600 1.200A3.500 3.500 0 0 0 7 18z" />
  </Svg>
);

export const IconPhoto: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="14" rx="2" />
    <path d="M8 6l1.500-2h5L16 6" />
    <circle cx="12" cy="13" r="3.500" />
  </Svg>
);

export const IconAlert: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 4l9 16H3L12 4z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);

export const IconCheck: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5 12.500l4.500 4.500L19 7.500" />
  </Svg>
);

export const IconClose: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconLock: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

export const IconSignOut: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" />
    <path d="M15 8l4 4-4 4M19 12H9" />
  </Svg>
);

export const IconInfo: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);

export const IconEmpty: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 13l2.500-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z" />
    <path d="M4 13h5l1 2h4l1-2h5" />
  </Svg>
);
