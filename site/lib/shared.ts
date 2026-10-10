/**
 * Repository coordinates for Edit on GitHub and the header links.
 */

/** GitHub coordinates for source links. */
export const gitConfig = {
  user: "omqkhafi",
  repo: "okmodel",
  branch: "main",
} as const;

/** Canonical GitHub repository URL. */
export const githubRepoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/**
 * Blob URL for a path from the repository root.
 *
 * @param path - Repo-relative path, such as `docs/quickstart.md`
 */
export function githubBlobUrl(path: string): string {
  return `${githubRepoUrl}/blob/${gitConfig.branch}/${path}`;
}

/**
 * npm package page for a package name.
 *
 * @param packageName - Name field from the root `package.json`
 */
export function npmPackageUrl(packageName: string): string {
  return `https://www.npmjs.com/package/${packageName}`;
}
