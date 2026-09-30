/**
 * bump-version — Unreleased → versioned section promotion.
 */

import { describe, expect, test } from "bun:test";
import { promoteUnreleasedSection } from "./bump-version.js";

describe("promoteUnreleasedSection", () => {
  test("renames Unreleased into vX.Y.Z and leaves a fresh empty Unreleased", () => {
    const raw = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### ✨ Added",
      "",
      "- New thing.",
      "",
      "### 🐛 Fixed",
      "",
      "- A bug.",
      "",
      "## v0.1.0 — 2026-01-01",
      "",
      "### ✨ Added",
      "",
      "- Old thing.",
      "",
    ].join("\n");

    const out = promoteUnreleasedSection(raw, "0.2.0", "2026-09-30");

    expect(out).toContain("## Unreleased\n\n## v0.2.0 — 2026-09-30");
    expect(out).toContain("- New thing.");
    expect(out).toContain("- A bug.");
    expect(out).toContain("## v0.1.0 — 2026-01-01");
    expect(out.indexOf("## Unreleased")).toBeLessThan(out.indexOf("## v0.2.0"));
    expect(out.indexOf("- New thing.")).toBeGreaterThan(out.indexOf("## v0.2.0"));
  });

  test("fails when Unreleased is missing", () => {
    expect(() =>
      promoteUnreleasedSection(
        "## v0.1.0 — 2026-01-01\n\n### ✨ Added\n\n- x.\n",
        "0.1.1",
        "2026-01-02",
      ),
    ).toThrow(/no ## Unreleased/);
  });

  test("fails when Unreleased has no bullets", () => {
    expect(() =>
      promoteUnreleasedSection(
        "# Changelog\n\n## Unreleased\n\n## v0.1.0 — 2026-01-01\n\n### ✨ Added\n\n- x.\n",
        "0.1.1",
        "2026-01-02",
      ),
    ).toThrow(/no bullets/);
  });
});
