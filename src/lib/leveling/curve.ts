// The network leveling curve and the capped True-Score-contribution function.
//
// These are pure, derive-at-read functions with no I/O. Experience (network_xp)
// is stored on participants; the level and the contribution are computed from it
// on demand and never stored. The curve is polynomial, which gives the intended
// progression: fast early levels, progressively much steeper later, and no
// maximum, so levels keep rising for the life of an account.
//
// The True Score boundary: noCluNetwork stores engagement XP and DERIVES a
// contribution value here. It does NOT compute, store, or name a True Score. The
// True Score is computed on noclulabs.com from the signal ledger.
// trueScoreContribution is the (capped) value noCluNetwork will emit as one
// authenticity signal in the bridge phase (phase 5); it is defined and tested
// here, and emitted nowhere in this slice.

// The polynomial curve constants (the documented portalNetwork values). Tuning
// the curve is a one-place change here. They are domain constants, not per-deploy
// configuration, so they live with the curve rather than in the environment.
export const XP_SCALE = 0.4879;
export const EXPONENT = 2.15;

// The contribution saturates at this level: levels at or above the cap contribute
// the maximum (1), so levels past it stay real and visible but add nothing more to
// the score. The saturation is also what removes any incentive to farm XP purely
// for score.
export const CONTRIBUTION_CAP_LEVEL = 50;

// The total XP required to REACH a level: floor((level / XP_SCALE) ^ EXPONENT).
// Level 0 (and anything below) needs 0 XP. The floor keeps every threshold an
// integer, so levelForXp is its exact inverse.
export function xpForLevel(level: number): number {
  if (level <= 0) {
    return 0;
  }
  return Math.floor(Math.pow(level / XP_SCALE, EXPONENT));
}

// The highest level whose xpForLevel is <= xp (the inverse of xpForLevel). The
// closed form floor(XP_SCALE * xp ^ (1 / EXPONENT)) can land one level off at a
// threshold because of floating-point drift, so it is corrected against the exact
// integer thresholds: first walk down while the current level's threshold exceeds
// xp, then walk up while the next level's threshold is still reachable. Each
// correction is bounded by the (sub-unit) drift, so at most a couple of iterations
// run, and the result is exact at every threshold. There is no maximum level.
export function levelForXp(xp: number): number {
  if (xp <= 0) {
    return 0;
  }
  let level = Math.floor(XP_SCALE * Math.pow(xp, 1 / EXPONENT));
  if (level < 0) {
    level = 0;
  }
  while (level > 0 && xpForLevel(level) > xp) {
    level -= 1;
  }
  while (xpForLevel(level + 1) <= xp) {
    level += 1;
  }
  return level;
}

// The capped contribution to the noCluID True Score, in the range [0, 1]: the
// level scaled by the cap and clamped at 1. This is NOT the True Score and is not
// emitted in this slice (see the module note); phase 5 emits it as one
// authenticity signal.
export function trueScoreContribution(xp: number): number {
  const level = levelForXp(xp);
  return Math.min(level, CONTRIBUTION_CAP_LEVEL) / CONTRIBUTION_CAP_LEVEL;
}
