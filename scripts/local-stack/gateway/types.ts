import type { GatewayConfig } from './config.ts';
import type { Db } from './db.ts';
import type { RateLimiter } from './ratelimit.ts';

export interface OtpOutboxEntry {
  code: string;
  channel: 'email' | 'sms';
  expiresAt: number;
}

/** Shared state handed to every route handler. */
export interface Ctx {
  cfg: GatewayConfig;
  db: Db;
  limiter: RateLimiter;
  /** Codes issued by the fake OTP provider, by normalised identifier (GET /dev/otp). */
  otpOutbox: Map<string, OtpOutboxEntry>;
  /** Invoke an Edge Function in-process; null when the function does not exist. */
  invokeFunction: (name: string, request: Request) => Promise<Response | null>;
}
