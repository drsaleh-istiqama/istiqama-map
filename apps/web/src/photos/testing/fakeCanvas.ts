/**
 * Fake image pipeline for unit tests (happy-dom has no real canvas): `createImageBitmap`,
 * `OffscreenCanvas` and the `<canvas>` fallback, with a configurable encoder. The encoded
 * "images" are filler bytes computed from the canvas size — like a real canvas, nothing of the
 * input file (and so none of its EXIF) can reach the output.
 */
import { vi } from 'vitest';

export interface EncodeCall {
  via: 'offscreen' | 'canvas';
  width: number;
  height: number;
  type: string;
  quality: number | undefined;
}

export interface FakeImaging {
  /** Registers the decoded size of an input blob (unregistered blobs fail to decode). */
  register<B extends Blob>(blob: B, width: number, height: number): B;
  encodes: EncodeCall[];
  decodes: Array<{ options: unknown }>;
  /** Decoded bitmaps not closed yet, and the maximum ever alive at once. */
  alive: number;
  maxAlive: number;
  closed: number;
  /** OffscreenCanvases shrunk to 0×0 after use. */
  released: number;
  /** MIME types the encoder produces; others come out as PNG (like Safari < 17 for WebP). */
  supported: Set<string>;
  /** Encoded size in bytes. */
  sizeFor: (width: number, height: number, quality: number | undefined, type: string) => number;
  /** Thrown from drawImage when set (out-of-memory simulation). */
  drawError: Error | null;
  /** Wait inside createImageBitmap (to observe concurrency). */
  decodeDelayMs: number;
  restore(): void;
}

const FILL = 0x50; // "P": never forms "Exif"

export function installFakeImaging(
  options: { offscreen?: boolean; bitmap?: boolean } = {},
): FakeImaging {
  const sizes = new WeakMap<Blob, { width: number; height: number }>();
  const state: FakeImaging = {
    register(blob, width, height) {
      sizes.set(blob, { width, height });
      return blob;
    },
    encodes: [],
    decodes: [],
    alive: 0,
    maxAlive: 0,
    closed: 0,
    released: 0,
    supported: new Set(['image/webp', 'image/jpeg', 'image/png']),
    sizeFor: (w, h, q) => Math.max(1, Math.round(w * h * (q ?? 0.92) * 0.25)),
    drawError: null,
    decodeDelayMs: 0,
    restore: () => undefined,
  };

  const makeCtx = () => ({
    fillStyle: '',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    fillRect: vi.fn(),
    drawImage: vi.fn(() => {
      if (state.drawError) throw state.drawError;
    }),
  });

  const encode = (
    via: EncodeCall['via'],
    width: number,
    height: number,
    type: string,
    quality?: number,
  ): Blob => {
    state.encodes.push({ via, width, height, type, quality });
    const out = state.supported.has(type) ? type : 'image/png';
    const size = state.sizeFor(width, height, quality, out);
    return new Blob([new Uint8Array(size).fill(FILL)], { type: out });
  };

  class FakeBitmap {
    private isClosed = false;
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      state.alive++;
      state.maxAlive = Math.max(state.maxAlive, state.alive);
    }
    close(): void {
      if (this.isClosed) return;
      this.isClosed = true;
      state.alive--;
      state.closed++;
    }
  }

  class FakeOffscreenCanvas {
    private ctx = makeCtx();
    private w: number;
    height: number;
    constructor(width: number, height: number) {
      this.w = width;
      this.height = height;
    }
    get width(): number {
      return this.w;
    }
    set width(value: number) {
      if (value === 0 && this.w !== 0) state.released++;
      this.w = value;
    }
    getContext(kind: string) {
      return kind === '2d' ? this.ctx : null;
    }
    async convertToBlob(opts: { type?: string; quality?: number } = {}): Promise<Blob> {
      if (this.w === 0) throw new Error('released canvas');
      return encode('offscreen', this.w, this.height, opts.type ?? 'image/png', opts.quality);
    }
  }

  const g = globalThis as Record<string, unknown>;
  const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };

  if (options.bitmap !== false) {
    g.createImageBitmap = vi.fn(async (blob: Blob, opts?: unknown) => {
      state.decodes.push({ options: opts });
      if (state.decodeDelayMs) await new Promise((r) => setTimeout(r, state.decodeDelayMs));
      const size = sizes.get(blob);
      if (!size)
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      return new FakeBitmap(size.width, size.height);
    });
  } else {
    delete g.createImageBitmap;
  }

  if (options.offscreen !== false) g.OffscreenCanvas = FakeOffscreenCanvas;
  else delete g.OffscreenCanvas;

  // <canvas> fallback
  const ctxFor = new WeakMap<HTMLCanvasElement, ReturnType<typeof makeCtx>>();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null;
      let ctx = ctxFor.get(this);
      if (!ctx) {
        ctx = makeCtx();
        ctxFor.set(this, ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement['getContext']);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    const blob = encode('canvas', this.width, this.height, type ?? 'image/png', quality);
    setTimeout(() => cb(blob), 0);
  });

  state.restore = () => {
    getContext.mockRestore();
    toBlob.mockRestore();
    if (saved.createImageBitmap === undefined) delete g.createImageBitmap;
    else g.createImageBitmap = saved.createImageBitmap;
    if (saved.OffscreenCanvas === undefined) delete g.OffscreenCanvas;
    else g.OffscreenCanvas = saved.OffscreenCanvas;
  };
  return state;
}

/** The bytes of a Blob. */
export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
