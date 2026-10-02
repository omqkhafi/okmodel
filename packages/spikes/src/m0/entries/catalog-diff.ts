/**
 * Bundle entry for the catalog and the catalog diff.
 *
 * Built by the M0 measurement script. Not a published export.
 */

import * as canonical from "../../catalog/canonical.js";
import * as graph from "../../catalog/graph.js";
import * as diff from "../../migrations/diff.js";

/** Catalog hashing, ordering, and identity diff kept live for the bundler. */
export const catalogDiff = { canonical, graph, diff };
