#!/usr/bin/env node
/* global process, console, URL, fetch, Buffer */
/**
 * CI shim for the e2e suite on the REAL Supabase stack (docs/CI.md §2.4).
 *
 * The Playwright helpers read sign-in codes from `GET <api>/dev/otp?identifier=…`, an endpoint
 * of the local gateway's fake OTP provider. Supabase has no such endpoint: its e-mails land in
 * the Mailpit (or, on older CLIs, Inbucket) mail catcher and phone numbers use the fixed codes
 * of `[auth.sms.test_otp]` in supabase/config.toml. This proxy listens on PROXY_PORT (54329):
 *
 *   GET /dev/health                 {"ok":true}
 *   GET /dev/otp?identifier=<id>    {"code":"123456"} from the newest mail / test_otp, else 404
 *   anything else                   forwarded unchanged to SUPABASE_URL (service-role REST calls
 *                                   of the test runner)
 *
 * The app under test is NOT pointed at this proxy; it talks to SUPABASE_URL directly.
 * Environment: SUPABASE_URL, MAIL_CATCHER_URL (both written by supabase-ci-env.mjs).
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PROXY_PORT ?? 54329);
const upstream = new URL(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321');
const mail = (process.env.MAIL_CATCHER_URL ?? 'http://127.0.0.1:54324').replace(/\/$/, '');

/** `[auth.sms.test_otp]` of supabase/config.toml: "<digits>" = "<code>". */
function testOtps() {
  const out = new Map();
  try {
    const file = fileURLToPath(new URL('../../supabase/config.toml', import.meta.url));
    let inTable = false;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const h = /^\s*\[([^\]]+)\]/.exec(line);
      if (h) inTable = h[1].trim() === 'auth.sms.test_otp';
      const kv = inTable && /^\s*"?(\+?\d+)"?\s*=\s*"(\d+)"/.exec(line);
      if (kv) out.set(kv[1].replace(/^\+/, ''), kv[2]);
    }
  } catch {
    // No config: phone sign-in is simply not available.
  }
  return out;
}
const PHONE_CODES = testOtps();

function codeFrom(text) {
  const s = String(text ?? '');
  return (/code[^0-9]{0,40}(\d{6})/i.exec(s) ?? /(?:^|[^\w-])(\d{6})(?:[^\w-]|$)/.exec(s))?.[1];
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/** Newest code mailed to `email`: Mailpit API first, Inbucket API as a fallback. */
async function mailedCode(email) {
  try {
    const query = encodeURIComponent(`to:"${email}"`);
    const list = await json(`${mail}/api/v1/search?query=${query}&limit=5`);
    for (const m of list.messages ?? []) {
      const msg = await json(`${mail}/api/v1/message/${m.ID}`);
      const code = codeFrom(msg.Text) ?? codeFrom(msg.HTML);
      if (code) return code;
    }
    return undefined;
  } catch {
    // Not Mailpit (older CLI): try Inbucket.
  }
  const box = encodeURIComponent(email.split('@')[0] ?? email);
  const items = await json(`${mail}/api/v1/mailbox/${box}`).catch(() => []);
  const newest = [...items].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  for (const item of newest.slice(0, 5)) {
    const msg = await json(`${mail}/api/v1/mailbox/${box}/${item.id}`).catch(() => null);
    const code = codeFrom(msg?.body?.text) ?? codeFrom(msg?.body?.html);
    if (code) return code;
  }
  return undefined;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://proxy');
  if (url.pathname === '/dev/health') return send(res, 200, { ok: true, upstream: upstream.href });
  if (url.pathname === '/dev/otp') {
    const identifier = (url.searchParams.get('identifier') ?? '').trim().toLowerCase();
    if (!identifier) return send(res, 400, { message: 'identifier required' });
    const phone = identifier.replace(/[\s+()-]/g, '');
    const code = /^\d{6,15}$/.test(phone)
      ? PHONE_CODES.get(phone)
      : await mailedCode(identifier).catch(() => undefined);
    return code ? send(res, 200, { code }) : send(res, 404, { message: 'no code yet' });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const forward = http.request(
    {
      host: upstream.hostname,
      port: upstream.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: upstream.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  forward.on('error', (error) => send(res, 502, { message: String(error) }));
  forward.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev-otp-proxy on http://127.0.0.1:${PORT} → ${upstream.href} (mail: ${mail})`);
});
