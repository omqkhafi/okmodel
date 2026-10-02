/**
 * Bundle entry for catalog, verifier, router, and registry together.
 *
 * Built by the M0 measurement script. Not a published export.
 */

import { catalogDiff } from "./catalog-diff.js";
import { registry } from "./registry.js";
import { router } from "./router.js";
import { verifier } from "./verifier.js";

/** All four representative modules in one bundle. */
export const combined = { catalogDiff, verifier, router, registry };
