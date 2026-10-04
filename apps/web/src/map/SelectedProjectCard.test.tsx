/**
 * The card of the selected project (v2 parity 1.4): its main action never scrolls away (the
 * facts scroll, the head and "View details" do not), the page gets the element to keep the map
 * clear of it, and switching projects does not take the card off screen in between.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from './queries';

const state = vi.hoisted(() => ({
  pending: new Map<string, (value: ProjectSummary | null) => void>(),
}));

vi.mock('./queries', () => ({
  projectSummary: (id: string) =>
    new Promise<ProjectSummary | null>((resolve) => state.pending.set(id, resolve)),
}));

const { SelectedProjectCard } = await import('./SelectedProjectCard');

function summary(id: string, code: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    code,
    name_ar: `مسجد ${code}`,
    name_latin: null,
    type: 'mosque',
    status: 'active',
    record_state: 'approved',
    capacity: 350,
    lon: 39.7,
    lat: -5.05,
    area: { name_ar: 'بوبوي', name_en: 'Bopwe', name_sw: 'Bopwe' },
    dirty: false,
    local: true,
    ...extra,
  };
}

async function answer(id: string, value: ProjectSummary | null): Promise<void> {
  await waitFor(() => expect(state.pending.has(id)).toBe(true));
  state.pending.get(id)!(value);
  state.pending.delete(id);
}

afterEach(() => {
  cleanup();
  state.pending.clear();
});

describe('SelectedProjectCard', () => {
  it('keeps "View details" outside the scrolling part of the card', async () => {
    render(<SelectedProjectCard selected={{ id: 'a' }} onClose={() => undefined} />);
    await answer('a', summary('a', 'TZ-PN-000001'));
    const card = await screen.findByTestId('map-project-card');
    const open = screen.getByTestId('map-project-open');
    const body = card.querySelector('.mapcard__body');
    const actions = card.querySelector('.mapcard__actions');
    expect(body).not.toBeNull();
    expect(actions?.parentElement).toBe(card);
    expect(actions?.contains(open)).toBe(true);
    expect(body?.contains(open)).toBe(false);
    // The facts are pairs (one wrapping line on phones) and still a description list.
    const pairs = card.querySelectorAll('.mapcard__facts > div');
    expect(pairs).toHaveLength(3);
    expect(card.querySelector('.mapcard__facts dt')?.textContent).toBeTruthy();
    expect(card.textContent).toContain('TZ-PN-000001');
    // On a phone the card covers the map's attribution control: it carries the attribution.
    const attribution = screen.getByTestId('map-card-attribution');
    expect(attribution.parentElement).toBe(card);
    expect(body?.contains(attribution)).toBe(false);
    expect(attribution.textContent).toContain('OpenStreetMap');
  });

  it('hands the card element to the page while it is on screen', async () => {
    const elementRef = vi.fn();
    const view = render(
      <SelectedProjectCard
        selected={{ id: 'a' }}
        onClose={() => undefined}
        elementRef={elementRef}
      />,
    );
    expect(elementRef).not.toHaveBeenCalledWith(expect.any(HTMLElement));
    await answer('a', summary('a', 'TZ-PN-000001'));
    const card = await screen.findByTestId('map-project-card');
    expect(elementRef).toHaveBeenLastCalledWith(card);
    view.unmount();
    expect(elementRef).toHaveBeenLastCalledWith(null);
  });

  it('switching projects keeps the card on screen until the next one is read', async () => {
    const elementRef = vi.fn();
    const onLoaded = vi.fn();
    const view = render(
      <SelectedProjectCard
        selected={{ id: 'a' }}
        onClose={() => undefined}
        onLoaded={onLoaded}
        elementRef={elementRef}
      />,
    );
    await answer('a', summary('a', 'TZ-PN-000001'));
    const card = await screen.findByTestId('map-project-card');
    elementRef.mockClear();

    view.rerender(
      <SelectedProjectCard
        selected={{ id: 'b' }}
        onClose={() => undefined}
        onLoaded={onLoaded}
        elementRef={elementRef}
      />,
    );
    expect(screen.getByTestId('map-project-card')).toBe(card);
    expect(card.getAttribute('aria-busy')).toBe('true');
    await answer('b', summary('b', 'TZ-PN-000002'));
    await waitFor(() => expect(card.getAttribute('data-id')).toBe('b'));
    expect(card.textContent).toContain('TZ-PN-000002');
    expect(card.hasAttribute('aria-busy')).toBe(false);
    expect(elementRef).not.toHaveBeenCalledWith(null);
    expect(onLoaded).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('a project that is not on the device shows the tile attributes', async () => {
    render(
      <SelectedProjectCard
        selected={{
          id: 'x',
          properties: { code: 'TZ-PS-000009', name_ar: 'مدرسة', type: 'school' },
        }}
        onClose={() => undefined}
      />,
    );
    await answer('x', null);
    const card = await screen.findByTestId('map-project-card');
    expect(card.textContent).toContain('TZ-PS-000009');
    expect(card.querySelector('.mapcard__actions .field__hint')).not.toBeNull();
  });
});
