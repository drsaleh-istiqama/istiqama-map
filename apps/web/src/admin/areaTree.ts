/**
 * Administrative-area tree of one country for the branch scope picker (brief §2.2:
 * `branches.admin_area_ids`). Pure functions over the synced `admin_areas` rows; a country
 * can have several thousand areas, so the picker renders only expanded nodes and search
 * results.
 */
import { norm } from '../lib/normalize';
import type { AreaNode } from './types';

export interface AreaTree {
  byId: ReadonlyMap<string, AreaNode>;
  /** Children per parent id; `''` holds the roots. Sorted by label. */
  children: ReadonlyMap<string, AreaNode[]>;
  /** Normalised label per id (search). */
  keys: ReadonlyMap<string, string>;
}

export function buildAreaTree(
  areas: readonly AreaNode[],
  label: (area: AreaNode) => string,
): AreaTree {
  const byId = new Map<string, AreaNode>();
  for (const area of areas) byId.set(area.id, area);
  const children = new Map<string, AreaNode[]>();
  const keys = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const area of areas) {
    const text = label(area);
    labels.set(area.id, text);
    keys.set(area.id, norm(text));
    // A parent outside the list (another country, deleted) makes the area a root.
    const parent = area.parent_id && byId.has(area.parent_id) ? area.parent_id : '';
    const list = children.get(parent);
    if (list) list.push(area);
    else children.set(parent, [area]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (labels.get(a.id) ?? '').localeCompare(labels.get(b.id) ?? ''));
  }
  return { byId, children, keys };
}

export function childrenOf(tree: AreaTree, id: string | null): AreaNode[] {
  return tree.children.get(id ?? '') ?? [];
}

/** Root → … → the area itself. */
export function areaPath(tree: AreaTree, id: string): AreaNode[] {
  const path: AreaNode[] = [];
  const seen = new Set<string>();
  let current = tree.byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parent_id ? tree.byId.get(current.parent_id) : undefined;
  }
  return path;
}

/** Areas whose name contains the query (normalised as on the server), shallow levels first. */
export function searchAreas(tree: AreaTree, query: string, limit = 80): AreaNode[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const hits: AreaNode[] = [];
  for (const [id, key] of tree.keys) {
    if (!key.includes(q)) continue;
    const area = tree.byId.get(id);
    if (area) hits.push(area);
  }
  hits.sort((a, b) => {
    const ka = tree.keys.get(a.id) ?? '';
    const kb = tree.keys.get(b.id) ?? '';
    const pa = ka.startsWith(q) ? 0 : 1;
    const pb = kb.startsWith(q) ? 0 : 1;
    return pa - pb || a.level - b.level || ka.localeCompare(kb);
  });
  return hits.slice(0, limit);
}

/** The nearest selected ancestor of an area (it is then covered already), or null. */
export function selectedAncestor(
  tree: AreaTree,
  id: string,
  selected: ReadonlySet<string>,
): string | null {
  const path = areaPath(tree, id);
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i];
    if (node && selected.has(node.id)) return node.id;
  }
  return null;
}

/** Selected ids that are not in this country's tree (deleted or moved areas). */
export function unknownIds(tree: AreaTree, ids: readonly string[]): string[] {
  return ids.filter((id) => !tree.byId.has(id));
}
