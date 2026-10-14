/**
 * A short in-memory log of what the sync engine did (pages stored, refusals, repairs, resets),
 * shown in the sync details panel so a user on a phone can report it. Technical text only:
 * table names, counts and browser messages, never row content.
 */
import { signal, type Signal } from '@preact/signals';

export interface TraceEntry {
  /** Epoch milliseconds. */
  at: number;
  text: string;
}

const MAX_ENTRIES = 40;

export const syncTrace: Signal<TraceEntry[]> = signal<TraceEntry[]>([]);

export function trace(text: string): void {
  syncTrace.value = [...syncTrace.peek(), { at: Date.now(), text }].slice(-MAX_ENTRIES);
}
