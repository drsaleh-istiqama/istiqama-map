/**
 * Structured (JSON lines) logging to stdout. Lines are buffered and flushed in batches so that
 * request logging does not throttle the proxy under load. Never pass tokens, API keys or
 * request bodies to these functions; request logs carry the path without its query string.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

let minLevel: 'info' | 'warn' | 'silent' = 'info';
let buffer: string[] = [];
let timer: NodeJS.Timeout | null = null;

export function setLogLevel(level: 'info' | 'warn' | 'silent'): void {
  minLevel = level;
}

export function flushLogs(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer.length) return;
  const chunk = buffer.join('');
  buffer = [];
  process.stdout.write(chunk);
}

function emit(line: string): void {
  buffer.push(line);
  if (buffer.length >= 512) flushLogs();
  else if (!timer) {
    timer = setTimeout(flushLogs, 100);
    timer.unref();
  }
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (minLevel === 'silent') return;
  if (minLevel === 'warn' && (level === 'info' || level === 'debug')) return;
  emit(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
  // Problems must reach the log even if the process dies right afterwards.
  if (level === 'error' || level === 'warn') flushLogs();
}

/** One line per HTTP request. At level "warn" only failures and slow requests are written. */
export function logRequest(
  method: string,
  path: string,
  status: number,
  ms: number,
  extra?: Record<string, unknown>,
): void {
  if (minLevel === 'silent') return;
  if (minLevel === 'warn' && status < 400 && ms < 1000) return;
  emit(
    JSON.stringify({
      t: new Date().toISOString(),
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      msg: 'request',
      method,
      path,
      status,
      ms: Math.round(ms * 10) / 10,
      ...extra,
    }) + '\n',
  );
}

process.on('exit', flushLogs);
