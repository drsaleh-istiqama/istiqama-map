import { describe, expect, it, vi } from 'vitest';
import {
  createWatchdog,
  REDEPLOY_COOLDOWN_MS,
  type ProbeResult,
  type WatchdogDeps,
} from './storageWatchdog.ts';

const BROKEN: ProbeResult = { ok: false, status: 500, detail: 'SignatureDoesNotMatch' };

function setup(results: ProbeResult[]) {
  let t = 0;
  const logs: string[] = [];
  const deps: WatchdogDeps = {
    probe: vi.fn(async () => results.shift() ?? { ok: true }),
    redeploy: vi.fn(async () => true),
    log: (_level, msg) => logs.push(msg),
    now: () => t,
  };
  return { deps, logs, advance: (ms: number) => (t += ms), dog: createWatchdog(deps) };
}

describe('storage watchdog', () => {
  it('a healthy storage: nothing happens', async () => {
    const { deps, dog, logs } = setup([{ ok: true }, { ok: true }]);
    await dog.tick();
    await dog.tick();
    expect(deps.redeploy).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('one failure is logged only; the second in a row redeploys Storage', async () => {
    const { deps, dog, logs } = setup([BROKEN, BROKEN]);
    await dog.tick();
    expect(deps.redeploy).not.toHaveBeenCalled();
    await dog.tick();
    expect(deps.redeploy).toHaveBeenCalledTimes(1);
    expect(logs).toContain('storage_watchdog_redeployed');
  });

  it('redeploys at most once per cooldown, then again if still broken', async () => {
    const { deps, dog, advance } = setup(Array(10).fill(BROKEN));
    (deps.redeploy as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await dog.tick();
    await dog.tick();
    await dog.tick();
    await dog.tick();
    expect(deps.redeploy).toHaveBeenCalledTimes(1);
    advance(REDEPLOY_COOLDOWN_MS);
    await dog.tick();
    expect(deps.redeploy).toHaveBeenCalledTimes(2);
  });

  it('a missing probe file (404) is reported but never redeploys', async () => {
    const missing: ProbeResult = { ok: false, status: 404, detail: 'not_found' };
    const { deps, dog } = setup([missing, missing, missing]);
    await dog.tick();
    await dog.tick();
    await dog.tick();
    expect(deps.redeploy).not.toHaveBeenCalled();
  });

  it('a recovery resets the count and is logged', async () => {
    const { deps, dog, logs } = setup([BROKEN, { ok: true }, BROKEN]);
    await dog.tick();
    await dog.tick();
    await dog.tick();
    expect(deps.redeploy).not.toHaveBeenCalled();
    expect(logs).toContain('storage_watchdog_recovered');
  });

  it('a probe that throws (network) counts as a failure', async () => {
    const { deps, dog } = setup([]);
    deps.probe = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const dog2 = createWatchdog(deps);
    await dog2.tick();
    await dog2.tick();
    expect(deps.redeploy).toHaveBeenCalledTimes(1);
    void dog;
  });
});
