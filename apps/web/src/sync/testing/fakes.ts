/**
 * TEST SUPPORT — small fakes for the environment ports (network, preferences, auth, locks,
 * resumable uploads).
 */
import { SyncError } from '../errors';
import type {
  AppInfo,
  AuthPort,
  ConnectionType,
  LockPort,
  NetworkPort,
  PrefsPort,
  ResumableUploader,
  SessionProblem,
  UploadRequest,
} from '../ports';

export class FakeNetwork implements NetworkPort {
  online = true;
  type: ConnectionType = 'unknown';
  dataSaver = false;
  private readonly changeListeners = new Set<(online: boolean) => void>();
  private readonly visibleListeners = new Set<() => void>();

  isOnline(): boolean {
    return this.online;
  }
  connectionType(): ConnectionType {
    return this.type;
  }
  saveData(): boolean {
    return this.dataSaver;
  }
  onChange(listener: (online: boolean) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  onVisible(listener: () => void): () => void {
    this.visibleListeners.add(listener);
    return () => this.visibleListeners.delete(listener);
  }
  /** Flip connectivity and fire the browser event. */
  setOnline(online: boolean): void {
    this.online = online;
    for (const l of [...this.changeListeners]) l(online);
  }
  becomeVisible(): void {
    for (const l of [...this.visibleListeners]) l();
  }
  get listenerCount(): number {
    return this.changeListeners.size + this.visibleListeners.size;
  }
}

export class FakePrefs implements PrefsPort {
  wifi = false;
  wifiOnly(): boolean {
    return this.wifi;
  }
}

export class FakeAuth implements AuthPort {
  user: string | null = 'user-1';
  device = 'device-a';
  token: string | null = 'token-1';
  readonly problems: SessionProblem[] = [];
  onProblem: ((problem: SessionProblem) => void | Promise<void>) | null = null;

  deviceId(): string {
    return this.device;
  }
  userId(): string | null {
    return this.user;
  }
  async accessToken(): Promise<string | null> {
    return this.token;
  }
  async onSessionProblem(problem: SessionProblem): Promise<void> {
    this.problems.push(problem);
    await this.onProblem?.(problem);
  }
}

export const fakeApp: AppInfo = {
  supabaseUrl: 'http://127.0.0.1:54321',
  anonKey: 'anon',
  appVersion: '3.0.0-test',
  deviceLabel: () => 'test device',
};

/** In-process mutex with the semantics of the Web Locks API. */
export class FakeLock implements LockPort {
  private held = false;
  private readonly waiters: Array<() => void> = [];
  /** Simulates another tab holding the lock. */
  heldElsewhere = false;

  async run<T>(fn: () => Promise<T>, opts: { wait: boolean }): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.heldElsewhere) return { acquired: false };
    while (this.held) {
      if (!opts.wait) return { acquired: false };
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.held = true;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      this.held = false;
      this.waiters.shift()?.();
    }
  }
}

export interface UploadCall {
  objectName: string;
  bucket: string;
  contentType: string;
  size: number;
  /** URL the upload was resumed from (null = new upload). */
  resumedFrom: string | null;
}

type UploadPlan =
  | { kind: 'ok' }
  /** Announce a URL, acknowledge `offset` bytes, then fail. */
  | { kind: 'partial'; offset: number; error: SyncError }
  | { kind: 'fail'; error: SyncError }
  /** Announce a URL and hang until the request is aborted. */
  | { kind: 'hang' };

/** Scripted stand-in for the TUS uploader. */
export class FakeUploader implements ResumableUploader {
  readonly calls: UploadCall[] = [];
  /** Object name → bytes stored. */
  readonly stored = new Map<string, number>();
  private readonly plans: UploadPlan[] = [];
  private urlSeq = 0;
  /** Called at the start of every upload (advance a clock, flip the network…). */
  onUpload: ((call: UploadCall) => void | Promise<void>) | null = null;

  plan(...plans: UploadPlan[]): void {
    this.plans.push(...plans);
  }

  async upload(req: UploadRequest): Promise<void> {
    const call: UploadCall = {
      objectName: req.objectName,
      bucket: req.bucket,
      contentType: req.contentType,
      size: req.blob.size,
      resumedFrom: req.uploadUrl,
    };
    this.calls.push(call);
    await this.onUpload?.(call);
    if (req.signal.aborted) throw new SyncError('aborted', 'upload aborted');
    const plan = this.plans.shift() ?? { kind: 'ok' };
    if (plan.kind === 'fail') throw plan.error;
    if (!req.uploadUrl) req.onUploadUrl(`http://tus.test/upload/${++this.urlSeq}`);
    if (plan.kind === 'partial') {
      req.onProgress(plan.offset, req.blob.size);
      throw plan.error;
    }
    if (plan.kind === 'hang') {
      await new Promise<never>((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new SyncError('aborted', 'upload aborted')), { once: true });
      });
    }
    req.onProgress(req.blob.size, req.blob.size);
    this.stored.set(req.objectName, req.blob.size);
  }
}
