/**
 * Open and close for a support chip.
 *
 * Hover, keyboard focus, and a tap each open it. A tap sticks until the
 * next tap, so a pointer leave after the tap does not close it.
 */

/** Which inputs are holding the tooltip open. */
export type TooltipState = {
  readonly hover: boolean;
  readonly focus: boolean;
  readonly sticky: boolean;
};

/** An input the chip handles. */
export type TooltipEvent = "enter" | "leave" | "focus" | "blur" | "tap";

/**
 * Whether any input is holding the tooltip open.
 *
 * @param state - Current inputs
 * @returns True when the table should show
 */
export function tooltipOpen(state: TooltipState): boolean {
  return state.hover || state.focus || state.sticky;
}

/**
 * Apply one input to the tooltip.
 *
 * @param state - Current inputs
 * @param event - What happened
 * @returns The next inputs
 */
export function tooltipEvent(state: TooltipState, event: TooltipEvent): TooltipState {
  if (event === "enter") return { ...state, hover: true };
  if (event === "leave") return { ...state, hover: false };
  if (event === "focus") return { ...state, focus: true };
  if (event === "blur") return { ...state, focus: false };
  return { ...state, sticky: !state.sticky };
}
