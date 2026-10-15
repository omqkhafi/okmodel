/**
 * The favicon tile is the OKM wordmark, one letter at a time, and the
 * file at `/icon.svg` is the O frame that ships before JavaScript.
 */

import { expect, test } from "bun:test";

import { okmLogoMarkCrossfadeSvg, okmLogoMarkSvg } from "../components/okm-logo-icon";

test("icon.svg is the O tile", async () => {
  const file = await Bun.file(new URL("../public/icon.svg", import.meta.url)).text();
  const mark = okmLogoMarkSvg("O");
  expect(file.trim()).toBe(mark);
  expect(mark).toContain('fill="#0D0D0D"');
  expect(mark).toContain('fill="#FFFFFF"');
  expect(mark).toContain("M75.93 78.029");
  expect(mark).not.toContain("M17.847 15.905");
  expect(mark).not.toContain("M83.153 65.49");
});

test("K and M are the other wordmark letters", () => {
  expect(okmLogoMarkSvg("K")).toContain("M17.847 15.905");
  expect(okmLogoMarkSvg("M")).toContain("M83.153 65.49");
});

test("a crossfade starts on the outgoing letter", () => {
  const frame = okmLogoMarkCrossfadeSvg("O", "K", 0);
  expect(frame).toContain('opacity="1.000"');
  expect(frame).toContain('opacity="0.000"');
  expect(frame).toContain("M75.93 78.029");
  expect(frame).toContain("M17.847 15.905");
});
