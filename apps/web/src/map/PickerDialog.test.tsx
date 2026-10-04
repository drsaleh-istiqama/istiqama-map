/**
 * Pick mode as the project form uses it (docs/V2_PARITY.md 1.8): "confirm and return",
 * "return without change", Esc (asking first only after a choice), and closing when the page
 * underneath changes or the app locks — the dialog lives on <body>, not on the route.
 */
import { fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Auth from '../auth';

const state = vi.hoisted(() => ({
  onPick: null as ((p: { lon: number; lat: number }) => void) | null,
}));

// The real map needs WebGL: a stand-in reports taps through the same `onPick` prop.
vi.mock('./MapView', () => ({
  default: (props: { onPick?: (p: { lon: number; lat: number }) => void }) => {
    state.onPick = props.onPick ?? null;
    return <div data-testid="fake-map" />;
  },
}));
vi.mock('../auth', async (importOriginal) => {
  const { signal } = await import('@preact/signals');
  const actual = await importOriginal<typeof Auth>();
  return { ...actual, pin: { ...actual.pin, locked: signal(false) } };
});

const { openPicker } = await import('./PickerDialog');
const { pin } = await import('../auth');
const { navigate } = await import('../routes');

const picker = () => document.querySelector('[data-testid="map-pick"]');
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function open(initial: { lon: number; lat: number } | null) {
  const settled = vi.fn();
  const result = openPicker(initial).then((value) => {
    settled(value);
    return value;
  });
  await waitFor(() => expect(picker()).not.toBeNull());
  return { settled, result };
}

function tap(lon: number, lat: number): void {
  expect(state.onPick).toBeTypeOf('function');
  state.onPick!({ lon, lat });
}

async function closed(settled: ReturnType<typeof vi.fn>, value: unknown): Promise<void> {
  await waitFor(() => expect(picker()).toBeNull());
  await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  expect(settled).toHaveBeenCalledWith(value);
  expect(document.documentElement.classList.contains('has-modal')).toBe(false);
}

beforeEach(() => {
  navigate('/projects/new');
  (pin.locked as { value: boolean }).value = false;
});

afterEach(() => {
  document.body.innerHTML = '';
  state.onPick = null;
});

describe('pick mode', () => {
  it('"return without change" closes pick mode and resolves null (the form keeps its point)', async () => {
    const { settled } = await open({ lon: 39.7, lat: -5.0 });
    fireEvent.click(byTestId('map-pick-cancel')!);
    await closed(settled, null);
  });

  it('"return without change" after a tap still gives null, and pressing it twice is harmless', async () => {
    const { settled } = await open({ lon: 39.7, lat: -5.0 });
    tap(39.75, -5.05);
    const cancel = byTestId('map-pick-cancel')!;
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    await closed(settled, null);
  });

  it('confirm returns the chosen point with source "map"', async () => {
    const { settled } = await open(null);
    expect(byTestId('map-pick-confirm')).toHaveProperty('disabled', true);
    tap(39.7291234, -5.0551234);
    await waitFor(() => expect(byTestId('map-pick-confirm')).toHaveProperty('disabled', false));
    expect(byTestId('map-pick-coords')?.textContent).toContain('-5.055123, 39.729123');
    fireEvent.click(byTestId('map-pick-confirm')!);
    await closed(settled, { lon: 39.729123, lat: -5.055123, source: 'map' });
  });

  it('Esc closes at once when nothing was chosen', async () => {
    const { settled } = await open(null);
    fireEvent.keyDown(document, { key: 'Escape' });
    await closed(settled, null);
  });

  it('Esc after a choice asks first: "keep choosing" stays, "discard" closes without change', async () => {
    const { settled } = await open({ lon: 39.7, lat: -5.0 });
    tap(39.8, -5.1);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(byTestId('confirm-dialog')).not.toBeNull());
    fireEvent.click(byTestId('confirm-cancel')!);
    await waitFor(() => expect(byTestId('confirm-dialog')).toBeNull());
    expect(picker()).not.toBeNull();
    expect(settled).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(byTestId('confirm-dialog')).not.toBeNull());
    fireEvent.click(byTestId('confirm-ok')!);
    await closed(settled, null);
  });

  it('closes without change when the route changes underneath (browser Back, a link)', async () => {
    const { settled } = await open({ lon: 39.7, lat: -5.0 });
    tap(39.8, -5.1);
    navigate('/map');
    await closed(settled, null);
  });

  it('closes without change when the app locks with the PIN', async () => {
    const { settled } = await open(null);
    (pin.locked as { value: boolean }).value = true;
    await closed(settled, null);
  });

  it('a second pick mode after a cancelled one works the same', async () => {
    const first = await open(null);
    fireEvent.click(byTestId('map-pick-cancel')!);
    await closed(first.settled, null);
    const second = await open(null);
    tap(39.1, -5.2);
    await waitFor(() => expect(byTestId('map-pick-confirm')).toHaveProperty('disabled', false));
    fireEvent.click(byTestId('map-pick-confirm')!);
    await closed(second.settled, { lon: 39.1, lat: -5.2, source: 'map' });
  });
});
