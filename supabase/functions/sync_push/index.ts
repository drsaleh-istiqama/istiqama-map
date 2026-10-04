/**
 * sync_push — rate-limited pass-through to `rpc/sync_push` (docs/contracts/sync.md §4).
 *
 * Body: `{ "p_ops": [...], "p_device_id": "…" }` (the RPC arguments). Accepted aliases:
 * `ops`, `device_id`; a missing device id is taken from the `x-device-id` header.
 * The response (results per op, or the PostgREST error with its status) is passed through.
 */
import { intEnv, serveIfEntryPoint } from '../_shared/env.ts';
import { createRpcProxy } from '../_shared/rpc-proxy.ts';

export const handler = createRpcProxy({
  name: 'sync_push',
  rpc: 'sync_push',
  // Same budget as the limiter inside the RPC (120 calls / minute / user).
  perMinute: intEnv('SYNC_PUSH_RATE_PER_MINUTE', 120, 1),
  // 50 operations per batch; long free-text fields are possible, photos never travel here.
  maxBodyBytes: intEnv('SYNC_PUSH_MAX_BYTES', 2 * 1024 * 1024, 1024),
  normalise: (body, req) => {
    const hasOps = 'p_ops' in body;
    const hasDevice = typeof body.p_device_id === 'string';
    if (hasOps && hasDevice && Object.keys(body).length === 2) return null;
    return {
      p_ops: hasOps ? body.p_ops : body.ops,
      p_device_id: hasDevice
        ? body.p_device_id
        : (body.device_id ?? req.headers.get('x-device-id')),
    };
  },
});

export default handler;
serveIfEntryPoint(import.meta, handler);
