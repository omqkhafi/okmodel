/**
 * Public site identity. The origin is the one constant every absolute URL
 * reads. The display name is the one constant every wordmark reads.
 */

/** Display name. The package name stays `okmodel`. */
export const SITE_NAME = "OKModel";

/**
 * Canonical origin with no trailing slash.
 * `SITE_ORIGIN` overrides the default when the site is served elsewhere.
 */
export const SITE_ORIGIN = (
  process.env.SITE_ORIGIN ?? "https://okmodel.omqkhafi.dev"
).replace(/\/$/, "");

/** SPDX Apache-2.0 deed. Matches the root `package.json` license. */
export const SITE_LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/** schema.org category for a developer library. */
export const SITE_APPLICATION_CATEGORY = "DeveloperApplication" as const;
