/**
 * The application mark, inline (same drawing as public/icons/icon.svg): a navy
 * rounded square with a gold map pin whose head holds a crescent. Decorative — the name of
 * the application is always written next to it.
 */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      class="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="512" height="512" rx="112" fill="#0f2545" />
      <rect
        x="20"
        y="20"
        width="472"
        height="472"
        rx="94"
        fill="none"
        stroke="#c8a24a"
        stroke-width="6"
        opacity="0.55"
      />
      <path
        d="M256 424C256 424 134 300 134 214A122 122 0 0 1 378 214C378 300 256 424 256 424Z"
        fill="#c8a24a"
      />
      <circle cx="256" cy="212" r="74" fill="#0f2545" />
      <circle cx="256" cy="212" r="50" fill="#c8a24a" />
      <circle cx="274" cy="200" r="42" fill="#0f2545" />
    </svg>
  );
}
