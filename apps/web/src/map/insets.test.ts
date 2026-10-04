import { describe, expect, it } from 'vitest';
import {
  clampInsets,
  coveredInsets,
  inVisiblePart,
  NO_INSETS,
  sameInsets,
  visibleCentre,
} from './insets';

// Geometry measured by the review on a Pixel 5 (393 × 727, map tab, Arabic and English).
const MAP = { top: 298, bottom: 666, left: 0, right: 393 };
const CARD = { top: 437, bottom: 658, left: 8, right: 385 };
const HEAT_AR = { top: 306, bottom: 358, left: 124, right: 385 };
const HEAT_EN = { top: 306, bottom: 358, left: 8, right: 335 };

describe('coveredInsets', () => {
  it('phone: the heat bar pads the top, the full-width card the bottom', () => {
    for (const heat of [HEAT_AR, HEAT_EN]) {
      const insets = coveredInsets(MAP, [heat, CARD]);
      expect(insets).toEqual({ top: 68, right: 0, bottom: 237, left: 0 });
    }
  });

  it('the selected project is then centred above the card, below the heat bar', () => {
    const insets = coveredInsets(MAP, [HEAT_EN, CARD]);
    const height = MAP.bottom - MAP.top;
    const centre = visibleCentre(MAP.right - MAP.left, height, insets);
    const yOnScreen = MAP.top + centre.y;
    expect(yOnScreen).toBeGreaterThan(HEAT_EN.bottom);
    expect(yOnScreen).toBeLessThan(CARD.top);
  });

  it('wide screen: a narrow card at the inline end pads that side, not the top', () => {
    const map = { top: 80, bottom: 860, left: 410, right: 1270 };
    const cardLtr = { top: 192, bottom: 470, left: 906, right: 1258 };
    expect(coveredInsets(map, [cardLtr])).toEqual({ top: 0, right: 372, bottom: 0, left: 0 });
    const cardRtl = { top: 192, bottom: 470, left: 422, right: 774 };
    expect(coveredInsets(map, [cardRtl])).toEqual({ top: 0, right: 0, bottom: 0, left: 372 });
  });

  it('ignores hidden panels and panels outside the map', () => {
    expect(coveredInsets(MAP, [null, undefined])).toEqual(NO_INSETS);
    expect(coveredInsets(MAP, [{ top: 0, bottom: 0, left: 0, right: 0 }])).toEqual(NO_INSETS);
    expect(coveredInsets(MAP, [{ top: 10, bottom: 60, left: 0, right: 393 }])).toEqual(NO_INSETS);
    expect(coveredInsets({ top: 0, bottom: 0, left: 0, right: 0 }, [CARD])).toEqual(NO_INSETS);
  });

  it('several panels on one side: the largest need wins', () => {
    const small = { top: 600, bottom: 658, left: 8, right: 385 };
    expect(coveredInsets(MAP, [small, CARD]).bottom).toBe(237);
  });
});

describe('clampInsets', () => {
  it('leaves room for the map between opposite paddings', () => {
    expect(clampInsets({ top: 68, right: 0, bottom: 237, left: 0 }, 393, 368)).toEqual({
      top: 68,
      right: 0,
      bottom: 237,
      left: 0,
    });
    const tight = clampInsets({ top: 100, right: 0, bottom: 300, left: 0 }, 393, 300);
    expect(tight.top + tight.bottom).toBeLessThanOrEqual(300 - 48);
    expect(tight.bottom).toBeGreaterThan(tight.top);
    expect(clampInsets(NO_INSETS, 0, 0)).toEqual(NO_INSETS);
  });
});

describe('helpers', () => {
  it('sameInsets ignores sub-pixel jitter', () => {
    expect(
      sameInsets(
        { top: 10, right: 0, bottom: 200, left: 0 },
        { top: 11, right: 0, bottom: 199, left: 0 },
      ),
    ).toBe(true);
    expect(sameInsets(NO_INSETS, { top: 0, right: 0, bottom: 40, left: 0 })).toBe(false);
  });

  it('inVisiblePart: a point under the card is not visible, one above it is', () => {
    const insets = { top: 68, right: 0, bottom: 237, left: 0 };
    expect(inVisiblePart({ x: 196, y: 184 }, 393, 368, insets)).toBe(false); // the old map centre
    expect(inVisiblePart({ x: 196, y: 100 }, 393, 368, insets)).toBe(true);
    expect(inVisiblePart({ x: 196, y: 40 }, 393, 368, insets)).toBe(false); // under the heat bar
  });
});
