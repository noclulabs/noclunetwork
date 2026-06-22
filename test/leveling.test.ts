import { describe, expect, it } from "vitest";
import {
  CONTRIBUTION_CAP_LEVEL,
  EXPONENT,
  XP_SCALE,
  levelForXp,
  trueScoreContribution,
  xpForLevel,
} from "@/lib/leveling/index.js";

describe("leveling constants", () => {
  it("are the documented portalNetwork values", () => {
    expect(XP_SCALE).toBe(0.4879);
    expect(EXPONENT).toBe(2.15);
    expect(CONTRIBUTION_CAP_LEVEL).toBe(50);
  });
});

describe("xpForLevel and levelForXp", () => {
  it("treats level 0 (and below) and non-positive XP as the floor", () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(-5)).toBe(0);
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(-100)).toBe(0);
    // Below the first threshold (xpForLevel(1) is 4) the level is still 0.
    expect(levelForXp(3)).toBe(0);
  });

  it("are exact inverses at every threshold across a wide range", () => {
    // For every level, the XP at its threshold maps back to exactly that level,
    // and one XP below the threshold maps to the level beneath it. This is the
    // property the float-drift guard in levelForXp exists to hold.
    for (let level = 1; level <= 2000; level += 1) {
      const threshold = xpForLevel(level);
      expect(levelForXp(threshold)).toBe(level);
      expect(levelForXp(threshold - 1)).toBe(level - 1);
    }
  });

  it("is exact at a boundary that the closed form alone gets wrong", () => {
    // xpForLevel(2) is exactly 20, but the closed form floor(XP_SCALE * 20^(1/E))
    // drifts to 1; the guard corrects it up to 2. Level holds at 2 right up to the
    // next threshold (xpForLevel(3) is 49) and ticks to 3 at it.
    expect(xpForLevel(2)).toBe(20);
    expect(levelForXp(20)).toBe(2);
    expect(levelForXp(48)).toBe(2);
    expect(xpForLevel(3)).toBe(49);
    expect(levelForXp(49)).toBe(3);
  });

  it("makes early levels cheap and later levels progressively much steeper", () => {
    // A handful of XP reaches the first levels; the same single-level step costs
    // far more XP higher up. The polynomial curve has no linear ceiling.
    expect(xpForLevel(1)).toBe(4);
    expect(xpForLevel(2)).toBe(20);
    const earlyStep = xpForLevel(2) - xpForLevel(1);
    const laterStep = xpForLevel(100) - xpForLevel(99);
    expect(laterStep).toBeGreaterThan(earlyStep);
    expect(xpForLevel(100)).toBeGreaterThan(xpForLevel(10) * 100);
  });

  it("keeps rising with no maximum level at very large XP", () => {
    // Levels keep growing for the life of an account: strictly increasing across
    // orders of magnitude, and still finite and well past the cap at the largest
    // safe integer.
    expect(levelForXp(1e6)).toBeGreaterThan(levelForXp(1e3));
    expect(levelForXp(1e9)).toBeGreaterThan(levelForXp(1e6));
    expect(levelForXp(1e15)).toBeGreaterThan(levelForXp(1e9));
    const atMax = levelForXp(Number.MAX_SAFE_INTEGER);
    expect(atMax).toBeGreaterThan(levelForXp(1e15));
    expect(atMax).toBeGreaterThan(CONTRIBUTION_CAP_LEVEL);
    expect(Number.isFinite(atMax)).toBe(true);
  });
});

describe("trueScoreContribution", () => {
  it("is zero at no XP and rises with level below the cap", () => {
    expect(trueScoreContribution(0)).toBe(0);
    expect(trueScoreContribution(xpForLevel(10))).toBeCloseTo(10 / CONTRIBUTION_CAP_LEVEL, 10);
    expect(trueScoreContribution(xpForLevel(25))).toBeCloseTo(25 / CONTRIBUTION_CAP_LEVEL, 10);
    expect(trueScoreContribution(xpForLevel(49))).toBeCloseTo(49 / CONTRIBUTION_CAP_LEVEL, 10);
    // Strictly increasing below the cap.
    expect(trueScoreContribution(xpForLevel(25))).toBeGreaterThan(
      trueScoreContribution(xpForLevel(10)),
    );
    expect(trueScoreContribution(xpForLevel(49))).toBeGreaterThan(
      trueScoreContribution(xpForLevel(25)),
    );
  });

  it("saturates at one at and above the cap level", () => {
    expect(trueScoreContribution(xpForLevel(CONTRIBUTION_CAP_LEVEL))).toBe(1);
    expect(trueScoreContribution(xpForLevel(CONTRIBUTION_CAP_LEVEL + 1))).toBe(1);
    expect(trueScoreContribution(xpForLevel(60))).toBe(1);
    expect(trueScoreContribution(xpForLevel(1000))).toBe(1);
    expect(trueScoreContribution(Number.MAX_SAFE_INTEGER)).toBe(1);
    // Just below the cap is under one, so the saturation is a real ceiling.
    expect(trueScoreContribution(xpForLevel(CONTRIBUTION_CAP_LEVEL - 1))).toBeLessThan(1);
  });

  it("never leaves the range zero to one", () => {
    for (const xp of [0, 1, 50, 660, 21031, 1e6, 1e12, Number.MAX_SAFE_INTEGER]) {
      const value = trueScoreContribution(xp);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
