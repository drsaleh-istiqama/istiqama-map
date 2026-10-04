import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export interface KeysetPage<T, C> {
  rows: T[];
  next: C | null;
  /** Rows matching in all (not only the loaded ones). */
  total: number;
}

export interface KeysetList<T> {
  /** Loaded rows, in order; never the same id twice. */
  rows: T[];
  /** Matching rows in all; null while the first page loads. */
  total: number | null;
  error: boolean;
  /** Appends the next keyset page (no-op while one is loading or at the end). */
  loadMore: () => void;
  hasMore: boolean;
  /** Drops a decided row at once (the next refresh agrees). */
  remove: (id: string) => void;
}

function appendUnique<T>(rows: T[], page: T[], idOf: (row: T) => string): T[] {
  const seen = new Set(rows.map(idOf));
  const out = rows.slice();
  for (const row of page) {
    const id = idOf(row);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(row);
    }
  }
  return out;
}

/**
 * Keyset pages behind a virtual list (brief §5: pages of 50 by a keyset cursor, never OFFSET,
 * never everything at once).
 *
 * - `key` changes (another user, another filter): the first page replaces everything;
 * - `refreshKey` changes (a sync cycle, a queued write): as many rows as are loaded are read
 *   again and swapped in at once, so the list — and its scroll position — stays where it was;
 * - `loadMore` (the list's `onEndReached`) appends the next page.
 */
export function useKeysetList<T, C>(
  fetchPage: (after: C | null) => Promise<KeysetPage<T, C>>,
  idOf: (row: T) => string,
  pageSize: number,
  key: string,
  refreshKey: string,
): KeysetList<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [next, setNext] = useState<C | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const loadedKey = useRef<string | null>(null);
  const rowsRef = useRef<T[]>(rows);
  rowsRef.current = rows;
  const latest = useRef({ fetchPage, idOf });
  latest.current = { fetchPage, idOf };

  useEffect(() => {
    const mine = ++generation.current;
    loadingMore.current = false;
    const sameKey = loadedKey.current === key;
    const wanted = sameKey ? Math.max(pageSize, rowsRef.current.length) : pageSize;
    if (!sameKey) setTotal(null);
    void (async () => {
      const { fetchPage: fetch, idOf: id } = latest.current;
      let loaded: T[] = [];
      let cursor: C | null = null;
      let count = 0;
      let first = true;
      do {
        const page: KeysetPage<T, C> = await fetch(cursor);
        if (generation.current !== mine) return;
        if (first) count = page.total;
        first = false;
        loaded = appendUnique(loaded, page.rows, id);
        cursor = page.next;
      } while (cursor !== null && loaded.length < wanted);
      loadedKey.current = key;
      setRows(loaded);
      setNext(cursor);
      setTotal(count);
      setError(false);
    })().catch(() => {
      if (generation.current !== mine) return;
      if (!sameKey) {
        setRows([]);
        setNext(null);
        setTotal(0);
      }
      setError(true);
    });
  }, [key, refreshKey, pageSize]);

  const loadMore = useCallback(() => {
    const cursor = next;
    if (cursor === null || loadingMore.current) return;
    loadingMore.current = true;
    const mine = generation.current;
    latest.current
      .fetchPage(cursor)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((r) => appendUnique(r, page.rows, latest.current.idOf));
        setNext(page.next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation.current === mine) loadingMore.current = false;
      });
  }, [next]);

  const remove = useCallback((id: string) => {
    const idOfRow = latest.current.idOf;
    if (!rowsRef.current.some((row) => idOfRow(row) === id)) return;
    setRows((r) => r.filter((row) => idOfRow(row) !== id));
    setTotal((n) => (n === null ? n : Math.max(0, n - 1)));
  }, []);

  return { rows, total, error, loadMore, hasMore: next !== null, remove };
}
