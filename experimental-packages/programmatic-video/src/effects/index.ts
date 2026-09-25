import type { Effect, Ease } from "../types";

const DEFAULT_DURATION = 0.6;
const DEFAULT_EASE: Ease = "power3.out";

function effect(
  type: string,
  overrides: Partial<Effect> = {},
): Effect {
  return {
    type: type as Effect["type"],
    duration: DEFAULT_DURATION,
    ease: DEFAULT_EASE,
    ...overrides,
  };
}

/** Fade an element in from opacity 0 */
export function fadeIn(opts?: Partial<Effect>): Effect {
  return effect("fadeIn", opts);
}

/** Fade an element out to opacity 0 */
export function fadeOut(opts?: Partial<Effect>): Effect {
  return effect("fadeOut", opts);
}

/** Slide an element in from a direction */
export function slideIn(
  direction: "left" | "right" | "up" | "down" = "left",
  distance?: number,
  opts?: Partial<Effect>,
): Effect {
  const dist = distance ?? 80;
  const offsets: Record<string, { x: number; y: number }> = {
    left: { x: -dist, y: 0 },
    right: { x: dist, y: 0 },
    up: { x: 0, y: -dist },
    down: { x: 0, y: dist },
  };
  return effect("slideIn", { from: offsets[direction], ...opts });
}

/** Slide an element out to a direction */
export function slideOut(
  direction: "left" | "right" | "up" | "down" = "left",
  distance?: number,
  opts?: Partial<Effect>,
): Effect {
  const dist = distance ?? 80;
  const offsets: Record<string, { x: number; y: number }> = {
    left: { x: -dist, y: 0 },
    right: { x: dist, y: 0 },
    up: { x: 0, y: -dist },
    down: { x: 0, y: dist },
  };
  return effect("slideOut", { to: offsets[direction], ...opts });
}

/** Scale an element in from 0 */
export function scaleIn(
  from?: number,
  opts?: Partial<Effect>,
): Effect {
  return effect("scaleIn", { from: from ?? 0, ...opts });
}

/** Scale an element out to 0 */
export function scaleOut(
  to?: number,
  opts?: Partial<Effect>,
): Effect {
  return effect("scaleOut", { to: to ?? 0, ...opts });
}

/** Rotate an element in */
export function rotateIn(
  from?: number,
  opts?: Partial<Effect>,
): Effect {
  return effect("rotateIn", { from: from ?? -15, ...opts });
}

/** Typewriter effect - reveal text character by character */
export function typewrite(opts?: Partial<Effect>): Effect {
  return effect("typewrite", { duration: 1.5, ease: "none" as Ease, ...opts });
}

/** Blur an element in */
export function blurIn(
  from?: number,
  opts?: Partial<Effect>,
): Effect {
  return effect("blurIn", { from: from ?? 10, ...opts });
}

/** Blur an element out */
export function blurOut(
  to?: number,
  opts?: Partial<Effect>,
): Effect {
  return effect("blurOut", { to: to ?? 10, ...opts });
}

/** Stagger multiple elements with a delay between each */
export function stagger(
  effects: Effect[],
  staggerDelay: number = 0.1,
): Effect[] {
  return effects.map((e, i) => ({
    ...e,
    delay: (e.delay ?? 0) + i * staggerDelay,
  }));
}

export const effects = {
  fadeIn,
  fadeOut,
  slideIn,
  slideOut,
  scaleIn,
  scaleOut,
  rotateIn,
  typewrite,
  blurIn,
  blurOut,
  stagger,
};
