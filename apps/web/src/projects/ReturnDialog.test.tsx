import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, db } from '../db';
import { freshDb, serverProject } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearViewFilters, currentRoute, navigate } from '../routes';
import ReviewPage from './ReviewPage';
import { resetSyncMocks, useRole } from './testkit';

const P1 = '00000000-0080-7000-8000-0000000000f1';
const NOTE = 'The photos are missing and the capacity looks wrong';

const dialogEntry = (): boolean =>
  typeof (window.history.state as { dialog?: unknown } | null)?.dialog === 'string';

async function openReturnDialog(): Promise<void> {
  await applyServerRows('projects', [
    serverProject({
      id: P1,
      name_ar: 'مسجد ١',
      name_latin: 'Masjid One',
      record_state: 'submitted',
    }),
  ]);
  navigate('/projects');
  navigate('/review');
  render(<ReviewPage />);
  const row = await screen.findByTestId('review-row');
  fireEvent.click(within(row).getByTestId('review-return'));
  await screen.findByTestId('return-dialog');
  await waitFor(() => expect(dialogEntry()).toBe(true));
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  useRole('branch_supervisor');
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('return note and the Back button (brief §7.4)', () => {
  it('Back with a typed note asks first, keeps the page, and keeps the note on "cancel"', async () => {
    await openReturnDialog();
    fireEvent.input(screen.getByTestId('return-note'), { target: { value: NOTE } });

    window.history.back();
    const ask = await screen.findByTestId('confirm-dialog');
    expect(currentRoute.value.path).toBe('/review');
    expect(screen.getByTestId('return-dialog')).toBeTruthy();
    // The page is not left while the question is open, even when Back is pressed again.
    window.history.back();
    await new Promise((r) => setTimeout(r, 50));
    expect(currentRoute.value.path).toBe('/review');

    fireEvent.click(within(ask).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect((screen.getByTestId('return-note') as HTMLTextAreaElement).value).toBe(NOTE);
    expect(dialogEntry()).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // the answer reaches the dialog (a human's pause)

    // Asked again on the next Back; "discard" closes the dialog and stays on the review page.
    window.history.back();
    fireEvent.click(within(await screen.findByTestId('confirm-dialog')).getByTestId('confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId('return-dialog')).toBeNull());
    await waitFor(() => expect(dialogEntry()).toBe(false));
    expect(currentRoute.value.path).toBe('/review');
    expect(screen.getByTestId('review-row')).toBeTruthy();
    expect((await db.projects.get(P1))?.record_state).toBe('submitted');
  });

  it('Back with an empty note just closes the dialog, without leaving the page', async () => {
    await openReturnDialog();
    window.history.back();
    await waitFor(() => expect(screen.queryByTestId('return-dialog')).toBeNull());
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    await waitFor(() => expect(dialogEntry()).toBe(false));
    expect(currentRoute.value.path).toBe('/review');
  });

  it('closing with "cancel" or sending takes the dialog entry off the history again', async () => {
    await openReturnDialog();
    fireEvent.click(screen.getByTestId('return-cancel'));
    await waitFor(() => expect(screen.queryByTestId('return-dialog')).toBeNull());
    await waitFor(() => expect(dialogEntry()).toBe(false));
    expect(currentRoute.value.path).toBe('/review');

    fireEvent.click(within(screen.getByTestId('review-row')).getByTestId('review-return'));
    await waitFor(() => expect(dialogEntry()).toBe(true));
    fireEvent.input(screen.getByTestId('return-note'), { target: { value: NOTE } });
    fireEvent.click(screen.getByTestId('return-confirm'));
    await waitFor(async () => expect((await db.projects.get(P1))?.record_state).toBe('returned'));
    await waitFor(() => expect(screen.queryByTestId('return-dialog')).toBeNull());
    await waitFor(() => expect(dialogEntry()).toBe(false));
    expect(currentRoute.value.path).toBe('/review');
  });
});
