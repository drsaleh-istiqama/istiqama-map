/**
 * Page-load metrics under APPLIED throttling (Chrome DevTools Protocol), the closest local
 * stand-in for a Lighthouse mobile run:
 *
 *   Network.emulateNetworkConditions   latency + throughput of the profile
 *   Emulation.setCPUThrottlingRate     4× slower CPU (Lighthouse's mobile default)
 *   PerformanceObserver (init script)  FCP (paint), LCP, layout shifts (CLS), long tasks (TBT)
 *
 * The profiles use Lighthouse's "DevTools-equivalent" numbers (lighthouse-core/config/
 * constants.js): request latency = RTT × 3.75, throughput × 0.9. On the loopback there is no
 * DNS/TCP/TLS setup to simulate, so these runs are slightly optimistic for the first request.
 */
import type { CDPSession, Page } from 'playwright';

export interface ThrottleProfile {
  id: string;
  label: string;
  /** Added to every request (ms). */
  latencyMs: number;
  downloadKbps: number;
  uploadKbps: number;
  cpuSlowdown: number;
}

export const PROFILES: Record<string, ThrottleProfile> = {
  'lh-mobile': {
    id: 'lh-mobile',
    label: 'Lighthouse mobile default (slow 4G: RTT 150 ms, 1.6 Mbps) + 4× CPU',
    latencyMs: 562.5,
    downloadKbps: 1474.56,
    uploadKbps: 675,
    cpuSlowdown: 4,
  },
  '3g': {
    id: '3g',
    label: 'Lighthouse "regular 3G" (RTT 300 ms, 700 kbps) + 4× CPU',
    latencyMs: 1125,
    downloadKbps: 630,
    uploadKbps: 630,
    cpuSlowdown: 4,
  },
  'slow-3g': {
    id: 'slow-3g',
    label: 'Chrome DevTools "Slow 3G" (2 s latency, 400 kbps) + 4× CPU',
    latencyMs: 2000,
    downloadKbps: 400,
    uploadKbps: 400,
    cpuSlowdown: 4,
  },
};

export interface LoadMetrics {
  /** ms from navigation start. */
  fcp: number | null;
  lcp: number | null;
  /** Total Blocking Time between FCP and the last long task (ms). */
  tbt: number;
  cls: number;
  /** Navigation start → load event (ms). */
  load: number | null;
  longTasks: number;
  requests: number;
  /** Bytes on the wire (encoded) of all requests of the page. */
  transferBytes: number;
  lcpElement: string | null;
}

/** Installed before any page script: buffers the entries the metrics are computed from. */
export const OBSERVER_SCRIPT = `(() => {
  const s = (window.__lhm = { fcp: null, lcp: null, lcpEl: null, shifts: [], longTasks: [] });
  const obs = (type, cb) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true }); } catch (e) {} };
  obs('paint', (e) => { if (e.name === 'first-contentful-paint') s.fcp = e.startTime; });
  obs('largest-contentful-paint', (e) => {
    s.lcp = e.startTime;
    const el = e.element;
    s.lcpEl = el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('data-testid') ? '[data-testid=' + el.getAttribute('data-testid') + ']' : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) : (e.url || null);
  });
  obs('layout-shift', (e) => { if (!e.hadRecentInput) s.shifts.push([e.startTime, e.value]); });
  obs('longtask', (e) => s.longTasks.push([e.startTime, e.duration]));
})();`;

interface RawEntries {
  fcp: number | null;
  lcp: number | null;
  lcpEl: string | null;
  shifts: [number, number][];
  longTasks: [number, number][];
  load: number | null;
}

/** CLS = the largest session window (gap < 1 s, window ≤ 5 s), as Chrome defines it. */
export function clsFromShifts(shifts: [number, number][]): number {
  let best = 0;
  let current = 0;
  let windowStart = -Infinity;
  let last = -Infinity;
  for (const [t, v] of [...shifts].sort((a, b) => a[0] - b[0])) {
    if (t - last > 1000 || t - windowStart > 5000) {
      current = 0;
      windowStart = t;
    }
    current += v;
    last = t;
    best = Math.max(best, current);
  }
  return Math.round(best * 1000) / 1000;
}

/** TBT: blocking part (> 50 ms) of every long task that starts after FCP. */
export function tbtFromLongTasks(longTasks: [number, number][], fcp: number | null): number {
  const from = fcp ?? 0;
  let total = 0;
  for (const [start, duration] of longTasks) {
    if (start + duration <= from) continue;
    const blockingStart = Math.max(start, from);
    const effective = start + duration - blockingStart;
    total += Math.max(0, effective - 50);
  }
  return Math.round(total);
}

export async function applyThrottling(cdp: CDPSession, p: ThrottleProfile): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: p.latencyMs,
    downloadThroughput: (p.downloadKbps * 1024) / 8,
    uploadThroughput: (p.uploadKbps * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpuSlowdown });
}

export async function clearThrottling(cdp: CDPSession): Promise<void> {
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

/** Counts requests and encoded bytes from the moment it is called. */
export function trackTransfer(cdp: CDPSession): () => { requests: number; bytes: number } {
  let requests = 0;
  let bytes = 0;
  const onSent = (): void => {
    requests++;
  };
  const onDone = (e: { encodedDataLength: number }): void => {
    bytes += e.encodedDataLength;
  };
  cdp.on('Network.requestWillBeSent', onSent);
  cdp.on('Network.loadingFinished', onDone);
  return () => {
    cdp.off('Network.requestWillBeSent', onSent);
    cdp.off('Network.loadingFinished', onDone);
    return { requests, bytes };
  };
}

/**
 * Waits until the page is "quiet": the load event has fired and no long task ended during the
 * last `quietMs` (Lighthouse's TTI uses a 5 s window), bounded by `maxMs`.
 */
export async function waitQuiet(page: Page, quietMs = 5000, maxMs = 45_000): Promise<void> {
  const started = Date.now();
  await page.waitForLoadState('load', { timeout: maxMs }).catch(() => undefined);
  for (;;) {
    const lastEnd = await page.evaluate(() => {
      const s = (window as unknown as { __lhm?: { longTasks: [number, number][] } }).__lhm;
      const tasks = s?.longTasks ?? [];
      const end = tasks.reduce((m, [st, d]) => Math.max(m, st + d), 0);
      return { end, now: performance.now() };
    });
    if (lastEnd.now - lastEnd.end >= quietMs || Date.now() - started > maxMs) return;
    await page.waitForTimeout(500);
  }
}

/** Reads the buffered entries and turns them into metrics. */
export async function readMetrics(
  page: Page,
  transfer: { requests: number; bytes: number },
): Promise<LoadMetrics> {
  const raw = await page.evaluate((): RawEntries => {
    const s = (window as unknown as { __lhm?: Omit<RawEntries, 'load'> }).__lhm;
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    return {
      fcp: s?.fcp ?? null,
      lcp: s?.lcp ?? null,
      lcpEl: s?.lcpEl ?? null,
      shifts: s?.shifts ?? [],
      longTasks: s?.longTasks ?? [],
      load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
    };
  });
  const round = (v: number | null): number | null => (v === null ? null : Math.round(v));
  return {
    fcp: round(raw.fcp),
    // Chrome reports no LCP entry when the largest paint is the FCP text node in some cases;
    // Lighthouse then falls back to FCP as well.
    lcp: round(raw.lcp ?? raw.fcp),
    tbt: tbtFromLongTasks(raw.longTasks, raw.fcp),
    cls: clsFromShifts(raw.shifts),
    load: round(raw.load),
    longTasks: raw.longTasks.length,
    requests: transfer.requests,
    transferBytes: transfer.bytes,
    lcpElement: raw.lcpEl,
  };
}
