// Run: npx tsx --test src/receptor/delta.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calibratedDelta, effectiveDelta, DELTA_BOUND } from "./delta.js";

describe("effectiveDelta", () => {
  it("is the calibrated base when nothing is learned", () => {
    assert.deepEqual(effectiveDelta({}), calibratedDelta());
  });

  it("adds the learned residual on top of the base", () => {
    const cal = calibratedDelta();
    const eff = effectiveDelta({ seeking: 0.05 });
    assert.equal(eff.seeking, Math.round(((cal.seeking ?? 0) + 0.05) * 1000) / 1000);
    assert.equal(eff.frustration, cal.frustration);
  });

  it("clamps the sum, not each part", () => {
    const eff = effectiveDelta({ confidence: 5 });
    assert.equal(eff.confidence, DELTA_BOUND);
  });
});
