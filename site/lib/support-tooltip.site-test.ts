/**
 * The chip tooltip opens from hover, keyboard focus, and a tap.
 *
 * Site tests are `bun test` with the MDX preload. There is no browser runner.
 * The open and close rules are this pure function, and the markup test renders
 * the chip with React.
 */

import { expect, test } from "bun:test";

import { tooltipEvent, tooltipOpen, type TooltipState } from "./support-tooltip";

const closed: TooltipState = { hover: false, focus: false, sticky: false };

test("hover opens the tooltip and leave closes it", () => {
  const hovered = tooltipEvent(closed, "enter");
  expect(tooltipOpen(hovered)).toBe(true);
  expect(tooltipOpen(tooltipEvent(hovered, "leave"))).toBe(false);
});

test("keyboard focus opens the tooltip and blur closes it", () => {
  const focused = tooltipEvent(closed, "focus");
  expect(tooltipOpen(focused)).toBe(true);
  expect(tooltipOpen(tooltipEvent(focused, "blur"))).toBe(false);
});

test("a tap sticks open after the pointer leaves", () => {
  const tapped = tooltipEvent(tooltipEvent(closed, "enter"), "tap");
  const left = tooltipEvent(tapped, "leave");
  expect(tooltipOpen(left)).toBe(true);
  expect(left.sticky).toBe(true);
  expect(tooltipOpen(tooltipEvent(left, "tap"))).toBe(false);
});
