// The "Share" button of a print view produces a real A4 PDF (download path; Chrome and WebKit).
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { appNavigate, signIn } from './helpers';

test.use({ locale: 'ar-OM' });

test('share builds a PDF of the summary report and of a project card', async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  });
  await signIn(page, request, 'supervisor.pemba@example.org');
  try {
    await expect(page.getByTestId('sync-last')).toHaveAttribute('data-at', /^\d+$/, { timeout: 90_000 });
  } catch (e) {
    await page.getByTestId('sync-toggle').click();
    console.log('TRACE ' + ((await page.getByTestId('sync-technical').textContent()) ?? ''));
    console.log('errors:', errors.slice(0, 8).join(' | '));
    throw e;
  }

  for (const path of ['summary', 'project']) {
    if (path === 'project') {
      const id = await page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const r = indexedDB.open('istiqama-map');
            r.onsuccess = () => {
              const c = r.result.transaction('projects').objectStore('projects').openCursor();
              c.onsuccess = () => resolve(String((c.result?.value as { id: string }).id));
            };
          }),
      );
      await appNavigate(page, `/reports/print/project/${id}`);
    } else {
      await appNavigate(page, '/reports');
      await expect(page.getByTestId('reports-pdf')).toBeEnabled({ timeout: 60_000 });
      await page.getByTestId('reports-pdf').click();
    }
    await expect(page.getByTestId('print-doc')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000); // photos / outline map
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.getByTestId('print-share').click(),
    ]);
    const out = `../../.local/screens/share-${path === 'project' ? 'project' : 'summary'}.pdf`;
    await download.saveAs(out);
    const head = fs.readFileSync(out).subarray(0, 5).toString();
    console.log(`PDF ${download.suggestedFilename()} ${fs.statSync(out).size} bytes head=${head}`);
    expect(head).toBe('%PDF-');
    await expect(page.getByTestId('share-dialog')).toBeVisible();
    await page.getByTestId('share-dialog').getByRole('button').last().click();
  }
  console.log('errors:', errors.slice(0, 5).join(' | ') || 'none');
});
