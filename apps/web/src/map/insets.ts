/**
 * Which part of the map is hidden by the panels drawn over it (the heat-map bar at the top,
 * the selected project's card at the bottom on phones or at the side on wide screens), as
 * camera padding: MapLibre then centres "fly to a project", "fit to the filter" and the
 * selection inside the part of the map the user can actually see. Pure geometry, no DOM.
 */

/** Camera padding in CSS pixels (physical sides, as MapLibre expects). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Readonly<Insets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Space kept between a panel and whatever the camera centres beside it. */
export const PANEL_GAP = 8;

/**
 * Padding that keeps clear of every panel. Each panel is attached to the edge of the map that
 * costs the smallest share of the map to keep clear of it (a full-width card at the bottom →
 * bottom; a narrow card at the side → that side); panels outside the map or without size
 * (hidden) are ignored. Per side the largest need wins.
 */
export function coveredInsets(
  area: RectLike,
  panels: ReadonlyArray<RectLike | null | undefined>,
  gap = PANEL_GAP,
): Insets {
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const out: Insets = { ...NO_INSETS };
  if (width <= 0 || height <= 0) return out;
  for (const p of panels) {
    if (!p || p.right - p.left <= 0 || p.bottom - p.top <= 0) continue;
    if (p.right <= area.left || p.left >= area.right) continue;
    if (p.bottom <= area.top || p.top >= area.bottom) continue;
    const need: Array<[keyof Insets, number, number]> = [
      ['top', p.bottom - area.top + gap, height],
      ['bottom', area.bottom - p.top + gap, height],
      ['left', p.right - area.left + gap, width],
      ['right', area.right - p.left + gap, width],
    ];
    let best = need[0]!;
    for (const candidate of need)
      if (candidate[1] / candidate[2] < best[1] / best[2]) best = candidate;
    const [side, px] = best;
    out[side] = Math.max(out[side], Math.round(px));
  }
  return out;
}

/**
 * Keeps at least `minFree` pixels of map between opposite paddings (a short phone in landscape
 * with a tall card): both sides shrink in proportion. MapLibre cannot centre in a negative area.
 */
export function clampInsets(insets: Insets, width: number, height: number, minFree = 48): Insets {
  const fit = (a: number, b: number, size: number): [number, number] => {
    const room = Math.max(0, size - minFree);
    const total = a + b;
    if (total <= room) return [a, b];
    if (total === 0) return [0, 0];
    const k = room / total;
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  const [top, bottom] = fit(insets.top, insets.bottom, height);
  const [left, right] = fit(insets.left, insets.right, width);
  return { top, right, bottom, left };
}

/** Equal within `tolerance` pixels on every side (no camera move for sub-pixel jitter). */
export function sameInsets(a: Insets, b: Insets, tolerance = 1): boolean {
  return (
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.right - b.right) <= tolerance &&
    Math.abs(a.bottom - b.bottom) <= tolerance &&
    Math.abs(a.left - b.left) <= tolerance
  );
}

/** True when a screen point (relative to the map) lies in the visible part, `margin` inside. */
export function inVisiblePart(
  point: { x: number; y: number },
  width: number,
  height: number,
  insets: Insets,
  margin = 24,
): boolean {
  return (
    point.x >= insets.left + margin &&
    point.x <= width - insets.right - margin &&
    point.y >= insets.top + margin &&
    point.y <= height - insets.bottom - margin
  );
}

/**
 * Screen point (relative to the map) where the camera centre is drawn with these insets: the
 * middle of the visible part. Used to change the padding without moving what is on screen.
 */
export function visibleCentre(
  width: number,
  height: number,
  insets: Insets,
): { x: number; y: number } {
  return {
    x: (width + insets.left - insets.right) / 2,
    y: (height + insets.top - insets.bottom) / 2,
  };
}
