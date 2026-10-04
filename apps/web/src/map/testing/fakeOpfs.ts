/**
 * In-memory Origin Private File System with the semantics that matter for resumable packs:
 * `createWritable()` works on a swap copy that replaces the file only on `close()`; `abort()`
 * (or a "crash" — dropping the writable) loses everything written since it was opened.
 */
import type { DirectoryHandleLike, FileHandleLike, WritableLike } from '../packStore';

class NotFoundError extends Error {
  constructor(name: string) {
    super(`${name} not found`);
    this.name = 'NotFoundError';
  }
}

export class FakeFile implements FileHandleLike {
  data = new Uint8Array(0);
  openWritables = 0;
  writablesOpened = 0;

  async getFile(): Promise<Blob> {
    return new Blob([this.data.slice()]);
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike> {
    let swap = options?.keepExistingData ? this.data.slice() : new Uint8Array(0);
    this.openWritables++;
    this.writablesOpened++;
    let open = true;
    const finish = (): void => {
      if (open) this.openWritables--;
      open = false;
    };
    return {
      write: async (params) => {
        if (!open) throw new Error('writable closed');
        if (params.type === 'truncate') {
          const next = new Uint8Array(params.size);
          next.set(swap.subarray(0, Math.min(params.size, swap.length)));
          swap = next;
          return;
        }
        const end = params.position + params.data.length;
        if (end > swap.length) {
          const next = new Uint8Array(end);
          next.set(swap);
          swap = next;
        }
        swap.set(params.data, params.position);
      },
      close: async () => {
        if (!open) return;
        this.data = swap;
        finish();
      },
      abort: async () => finish(),
    };
  }
}

export class FakeDirectory implements DirectoryHandleLike {
  readonly dirs = new Map<string, FakeDirectory>();
  readonly files = new Map<string, FakeFile>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new NotFoundError(name);
      dir = new FakeDirectory();
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    let file = this.files.get(name);
    if (!file) {
      if (!options?.create) throw new NotFoundError(name);
      file = new FakeFile();
      this.files.set(name, file);
    }
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new NotFoundError(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of [...this.dirs.keys(), ...this.files.keys()]) yield name;
  }
}
