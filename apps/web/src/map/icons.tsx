/** Map-specific inline icons (same drawing rules as src/ui/icons.tsx: 24 × 24, currentColor). */
import type { ComponentChildren } from 'preact';
import type { IconProps } from '../ui';

function Svg({ size = 24, children }: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      class="icon"
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

export const IconLocate = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 2 8l10 5 10-5-10-5z" />
    <path d="m2 13 10 5 10-5" />
  </Svg>
);

export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z" />
    <circle cx="12" cy="10.5" r="2" />
  </Svg>
);
