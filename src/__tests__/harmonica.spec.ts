/**
 * Unit tests for the Harmonica navigation math, with no DOM.
 */

import {
  atEnd,
  easeOutCubic,
  giveLength,
  pullIncrement,
  pullStep,
  springPull
} from '../harmonica';

describe('give length', () => {
  it('is 44px at a base of 88px or more', () => {
    expect(giveLength(88)).toBe(44);
    expect(giveLength(400)).toBe(44);
  });

  it('is half the base below 88px, rounded down, and never under one pull step', () => {
    expect(giveLength(60)).toBe(30);
    expect(giveLength(87)).toBe(43);
    expect(giveLength(5)).toBe(3);
    expect(giveLength(0)).toBe(3);
  });
});

describe('pull step', () => {
  it('adds a quarter of the wheel distance, at least 3px', () => {
    expect(pullIncrement(100)).toBe(25);
    expect(pullIncrement(-100)).toBe(25);
    expect(pullIncrement(4)).toBe(3);
    expect(pullStep(0, 100, 44)).toBe(25);
    expect(pullStep(10, 1, 44)).toBe(13);
  });

  it('clamps at the give length', () => {
    expect(pullStep(40, 100, 44)).toBe(44);
    expect(pullStep(0, 400, 30)).toBe(30);
  });
});

describe('boundary', () => {
  it('a list at its bottom is at the end for a downward wheel and not for an upward one', () => {
    // Bottom: scrollTop 100 plus the held base 100 reaches scrollHeight 200
    expect(atEnd(100, 200, 100, 1)).toBe(true);
    expect(atEnd(100, 200, 100, -1)).toBe(false);
    // Middle: neither end for the downward wheel
    expect(atEnd(50, 200, 100, 1)).toBe(false);
    // Top: the upward wheel's end
    expect(atEnd(0, 200, 100, -1)).toBe(true);
  });

  it('a list that cannot scroll is at both ends', () => {
    expect(atEnd(0, 40, 40, 1)).toBe(true);
    expect(atEnd(0, 40, 40, -1)).toBe(true);
    expect(atEnd(0, 0, 0, 1)).toBe(true);
  });

  it('reads the held base height and never a shrunken client height', () => {
    // The preview shrank the box to 20px; the held base of 100px still puts
    // the list at its bottom, so the gesture primes the switch
    expect(atEnd(100, 200, 100, 1)).toBe(true);
    expect(atEnd(100, 200, 20, 1)).toBe(false);
  });
});

describe('fold easing', () => {
  it('runs from 0 to 1 as ease-out cubic', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    expect(easeOutCubic(0.25)).toBeCloseTo(0.578125);
  });
});

describe('spring', () => {
  it('decays the pull and settles under 300ms', () => {
    expect(springPull(44, 0)).toBe(44);
    expect(Math.abs(springPull(44, 100))).toBeLessThan(44);
    expect(Math.abs(springPull(44, 300))).toBeLessThan(1);
  });
});
