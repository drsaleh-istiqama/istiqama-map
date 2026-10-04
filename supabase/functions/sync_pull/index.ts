/**
 * sync_pull — rate-limited pass-through to `rpc/sync_pull` (docs/contracts/sync.md §5).
 *
 * Body: `{ "p_cursor": <cursor | null>, "p_limit": 500 }` (the RPC arguments). Accepted
 * aliases: `cursor`, `limit`. The response is passed through unchanged.
 */
import { intEnv, serveIfEntryPoint } from '../_shared/env.ts';
import { createRpcProxy } from '../_shared/rpc-proxy.ts';

export const handler = createRpcProxy({
  name: 'sync_pull',
  rpc: 'sync_pull',
  // Same budget as the limiter inside the RPC (600 calls / minute / user).
  perMinute: intEnv('SYNC_PULL_RATE_PER_MINUTE', 600, 1),
  maxBodyBytes: 64 * 1024, // a cursor is a small JSON object
  normalise: (body) => {
    const out: Record<string, unknown> = {
      p_cursor: 'p_cursor' in body ? body.p_cursor : (body.cursor ?? null),
    };
    const limit = 'p_limit' in body ? body.p_limit : body.limit;
    if (limit !== undefined && limit !== null) out.p_limit = limit;
    return out;
  },
});

export default handler;
serveIfEntryPoint(import.meta, handler);
