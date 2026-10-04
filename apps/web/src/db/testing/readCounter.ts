/**
 * Test instrument: counts what a query really reads from IndexedDB, below Dexie's API.
 *
 *   rows = objects materialised (get, getMany, getAll, every position of a value cursor)
 *   keys = index / primary keys read without their objects (getAllKeys, key cursors)
 *
 * Native `count()` calls load nothing and are not counted. Used by the performance tests to
 * prove that lists and searches read O(page) rows however large the stores are. Install it
 * BEFORE the database is opened (Dexie builds its middleware stack on open).
 */
import type { DBCore, DBCoreCursor, DBCoreTable, Dexie } from 'dexie';

export interface ReadCount {
  rows: number;
  keys: number;
}

export interface ReadCounter extends ReadCount {
  /** Per store. */
  byTable: Record<string, ReadCount>;
  reset(): void;
  /** Runs `fn` and returns what it read (the counter is reset before). */
  measure<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; rows: number; keys: number; byTable: Record<string, ReadCount> }>;
  uninstall(): void;
}

const MIDDLEWARE_NAME = 'test-read-counter';

export function installReadCounter(db: Dexie): ReadCounter {
  const counter: ReadCounter = {
    rows: 0,
    keys: 0,
    byTable: {},
    reset() {
      counter.rows = 0;
      counter.keys = 0;
      counter.byTable = {};
    },
    async measure<T>(fn: () => Promise<T>) {
      counter.reset();
      const result = await fn();
      return { result, rows: counter.rows, keys: counter.keys, byTable: { ...counter.byTable } };
    },
    uninstall() {
      db.unuse({ stack: 'dbcore', name: MIDDLEWARE_NAME });
    },
  };

  const add = (table: string, kind: keyof ReadCount, n: number): void => {
    if (n <= 0) return;
    counter[kind] += n;
    const entry = (counter.byTable[table] ??= { rows: 0, keys: 0 });
    entry[kind] += n;
  };

  db.use({
    stack: 'dbcore',
    name: MIDDLEWARE_NAME,
    create(down: DBCore): DBCore {
      return {
        ...down,
        table(name: string): DBCoreTable {
          const t = down.table(name);
          return {
            ...t,
            get(req) {
              add(name, 'rows', 1);
              return t.get(req);
            },
            getMany(req) {
              add(name, 'rows', req.keys.length);
              return t.getMany(req);
            },
            query(req) {
              return t.query(req).then((res) => {
                add(name, req.values ? 'rows' : 'keys', res.result.length);
                return res;
              });
            },
            openCursor(req) {
              return t.openCursor(req).then((cursor) => {
                if (!cursor) return cursor;
                const kind: keyof ReadCount = req.values ? 'rows' : 'keys';
                // Same technique as Dexie's own middlewares: a derived object that forwards
                // the native accessors and counts every position the iteration stops at.
                return Object.create(cursor, {
                  key: { get: () => cursor.key },
                  primaryKey: { get: () => cursor.primaryKey },
                  value: { get: () => cursor.value as unknown },
                  done: { get: () => cursor.done },
                  start: {
                    value: (onNext: () => void) =>
                      cursor.start(() => {
                        add(name, kind, 1);
                        onNext();
                      }),
                  },
                }) as DBCoreCursor;
              });
            },
          };
        },
      };
    },
  });

  return counter;
}
