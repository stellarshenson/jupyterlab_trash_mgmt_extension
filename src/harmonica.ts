/**
 * The Harmonica navigation math: pure functions with no DOM. The panel's
 * wheel controller renders these values; the jest suite tests them directly.
 */

/** The pull one wheel event adds: a quarter of its distance, at least 3px. */
export function pullIncrement(deltaY: number): number {
  return Math.max(3, Math.abs(deltaY) / 4);
}

/** The pull after one event, from the pull on screen, up to the give length. */
export function pullStep(pull: number, deltaY: number, give: number): number {
  return Math.min(give, pull + pullIncrement(deltaY));
}

/**
 * The pull that folds the section: 44px at a base of 88px or more, else half
 * the base rounded down, and never under one pull step.
 */
export function giveLength(base: number): number {
  return base >= 88 ? 44 : Math.max(3, Math.floor(base / 2));
}

/**
 * True when the list sits at the end the wheel pushes towards. The held base
 * height decides, never the shrunken client height of a preview.
 */
export function atEnd(
  scrollTop: number,
  scrollHeight: number,
  base: number,
  direction: 1 | -1
): boolean {
  return direction === 1
    ? scrollTop + base >= scrollHeight - 1
    : scrollTop <= 0;
}

/** The fold's ease-out cubic curve. */
export function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

/** The damped spring that returns a short pull to rest. */
export function springPull(from: number, elapsedMs: number): number {
  const t = elapsedMs / 1000;
  return from * Math.exp(-7 * t) * Math.cos(16 * t);
}
