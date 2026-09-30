/**
 * Folder name to rank for the source layers.
 *
 * `contracts` is the lowest layer and `tooling` is the highest. `layers-check`
 * and `core-purity` both read this map.
 */
export const LAYER_RANK = {
  contracts: 0,
  dialects: 1,
  adapters: 2,
  runtime: 3,
  tooling: 4,
} as const;

/** A source layer folder. */
export type LayerName = keyof typeof LAYER_RANK;

const HIGHEST_LAYER: LayerName = (Object.keys(LAYER_RANK) as LayerName[]).reduce(
  (best, name) => (LAYER_RANK[name] > LAYER_RANK[best] ? name : best),
  "contracts",
);

/**
 * Returns the rank of a layer folder, or `undefined` when the name is not a layer.
 */
export function layerRank(folder: string): number | undefined {
  if (!isLayerName(folder)) {
    return undefined;
  }
  return LAYER_RANK[folder];
}

/**
 * Reports whether `folder` is a layer name.
 */
export function isLayerName(folder: string): folder is LayerName {
  return Object.hasOwn(LAYER_RANK, folder);
}

/**
 * Reports whether a top-level folder is the portable core.
 *
 * Every layer below the highest rank is core. A file outside the layer folders
 * is treated as core so a stray `node:` import cannot hide.
 */
export function isCoreFolder(folder: string | undefined): boolean {
  return folder !== HIGHEST_LAYER;
}
