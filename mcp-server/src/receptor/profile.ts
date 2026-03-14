// ============================================================
// Receptor — Emotion Profile Loader
// ============================================================
// Single source of truth for all numeric tuning constants.
// emotion.ts, ambient.ts, meta.ts read from this module.
// Developers tune emotion-profile.json, not source code.

import type { EmotionAxis } from "./types.js";
import raw from "./emotion-profile.json" with { type: "json" };

// ---- Type definitions ----

type AxisRecord = Partial<Record<EmotionAxis, number>>;

export interface EmotionProfile {
  accumulator: {
    halfLife: Record<EmotionAxis, number>;
    idleFreezeMs: number;
    interTurnCapMs: number;
  };
  impulse: {
    event: Record<string, AxisRecord>;
    pattern: Record<string, AxisRecord>;
    heatmapShift: AxisRecord;
    fatigue: { base: number; hourlyRate: number };
  };
  signal: {
    defaultThreshold: number;
    holdReleaseCount: number;
    compounds: Array<{
      id: string;
      requires: EmotionAxis[];
      intensity: "max" | "sum";
      priority: boolean;
    }>;
  };
  ambient: {
    timeConstantMs: number;
    silenceGateMs: number;
    silenceFloor: number;
    offsets: Record<EmotionAxis, number>;
    minThreshold: number;
    maxThreshold: number;
  };
  meta: {
    bufferSize: number;
    dangerHitRate: number;
    safeHitRate: number;
    maxFieldAdjustment: number;
    adjustmentStep: number;
    flowDisruption: { ratio: number; threshold: number };
    stateThresholds: Record<string, { axis: EmotionAxis; min: number; pattern: string }>;
  };
}

/** The loaded profile (immutable at runtime). */
export const profile: EmotionProfile = raw as unknown as EmotionProfile;
