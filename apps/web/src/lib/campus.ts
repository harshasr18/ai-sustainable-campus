/**
 * Block, spot and category name lookup.
 *
 * WHY THIS EXISTS. Issue and report rows carry `blockId`, `spotId` and `categoryId` — stable
 * identifiers, which is right (§4: "Use stable ids rather than matching on display names").
 * They deliberately do NOT carry denormalised display names, because a name is editable and
 * an id is not. So the UI resolves names from the campus reference lists.
 *
 * ONE request per list per page load. The promises below are module-level and shared, so a
 * table of forty issues causes two lookups, not eighty. These lists are small (tens of rows)
 * and change rarely, which is what makes caching them here reasonable rather than a job for a
 * query-cache library.
 *
 * `clearCampusCache()` runs on sign-out. Without it, the next person to sign in on a shared
 * machine could see the previous session's campus list from memory.
 */

import { useCallback } from 'react';
import { api, ApiError } from './api.js';
import { useAsync } from './useAsync.js';
import type { Block, Category, Paginated, Spot } from './types.js';

export interface CampusLookup {
  blocks: Block[];
  categories: Category[];
  loading: boolean;
  error: ApiError | null;
  /** Resolved name, or a neutral placeholder. Never a UUID, never an invented label. */
  blockName: (id: string | null | undefined) => string;
  categoryName: (id: string | null | undefined) => string;
  spotName: (blockId: string, spotId: string) => Promise<string>;
  reload: () => void;
}

let blocksPromise: Promise<Paginated<Block>> | null = null;
let categoriesPromise: Promise<Paginated<Category>> | null = null;
const spotPromises = new Map<string, Promise<Paginated<Spot>>>();

/** Caches successful results only — a failure must be retryable by the next mount. */
function loadBlocks(): Promise<Paginated<Block>> {
  const existing = blocksPromise;
  if (existing) return existing;
  const promise = api
    .get<Paginated<Block>>('/v1/campus/blocks')
    .then((value) => value)
    .catch((error: unknown) => {
      blocksPromise = null;
      throw error;
    });
  blocksPromise = promise;
  return promise;
}

function loadCategories(): Promise<Paginated<Category>> {
  const existing = categoriesPromise;
  if (existing) return existing;
  const promise = api
    .get<Paginated<Category>>('/v1/campus/categories')
    .then((value) => value)
    .catch((error: unknown) => {
      categoriesPromise = null;
      throw error;
    });
  categoriesPromise = promise;
  return promise;
}

function loadSpots(blockId: string): Promise<Paginated<Spot>> {
  const existing = spotPromises.get(blockId);
  if (existing) return existing;
  const promise = api
    .get<Paginated<Spot>>(`/v1/campus/blocks/${blockId}/spots`)
    .then((value) => value)
    .catch((error: unknown) => {
      spotPromises.delete(blockId);
      throw error;
    });
  spotPromises.set(blockId, promise);
  return promise;
}

/** Drops the cache so a second user never reads the first one's lists. */
export function clearCampusCache(): void {
  blocksPromise = null;
  categoriesPromise = null;
  spotPromises.clear();
}

export function useCampusLookup(): CampusLookup {
  // The signal is intentionally unused: these promises are shared between components and
  // aborting them on one component's unmount would cancel another's request.
  const blocks = useAsync(() => loadBlocks(), []);
  const categories = useAsync(() => loadCategories(), []);

  const blockName = useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—';
      return blocks.data?.items.find((block) => block.id === id)?.officialName ?? 'Unknown block';
    },
    [blocks.data],
  );

  const categoryName = useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—';
      return categories.data?.items.find((category) => category.id === id)?.name ?? 'Unknown category';
    },
    [categories.data],
  );

  const spotName = useCallback(async (blockId: string, spotId: string) => {
    try {
      const result = await loadSpots(blockId);
      return result.items.find((spot) => spot.id === spotId)?.officialName ?? 'Unknown spot';
    } catch {
      return 'Unknown spot';
    }
  }, []);

  return {
    blocks: blocks.data?.items ?? [],
    categories: categories.data?.items ?? [],
    loading: blocks.loading || categories.loading,
    error: blocks.error ?? categories.error,
    blockName,
    categoryName,
    spotName,
    reload: () => {
      clearCampusCache();
      blocks.reload();
      categories.reload();
    },
  };
}
