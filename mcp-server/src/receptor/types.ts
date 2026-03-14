// ============================================================
// Receptor — Shared types
// ============================================================
// All types for the receptor subsystem live here.
// engram core (../types.ts) does NOT import from this file.

// ---- Normalized event (output of environment mapper) ----

export type NormalizedAction =
  | "file_read"
  | "file_edit"
  | "search"
  | "shell_exec"
  | "delegation"
  | "memory_read"
  | "memory_write";

export interface NormalizedEvent {
  action: NormalizedAction;
  path?: string;
  result?: "success" | "failure" | "empty";
  ts: number;
}

// ---- Emotion vector (6-axis) ----

export interface EmotionVector {
  frustration: number; // negative: stuck, no solution visible
  hunger: number;      // negative: knowledge gap
  uncertainty: number; // negative: direction lost
  confidence: number;  // positive: hypothesis confirmed
  fatigue: number;     // meta: cognitive load accumulation
  flow: number;        // positive: thought and action aligned
}

export const ZERO_EMOTION: Readonly<EmotionVector> = {
  frustration: 0,
  hunger: 0,
  uncertainty: 0,
  confidence: 0,
  fatigue: 0,
  flow: 0,
};

export type EmotionAxis = keyof EmotionVector;

// ---- Fire signal (emotion → connection target) ----

export type FireSignalKind =
  | "frustration_spike"
  | "hunger_spike"
  | "uncertainty_sustained"
  | "confidence_sustained"
  | "fatigue_rising"
  | "flow_active"
  | "compound_frustration_hunger";

export interface FireSignal {
  kind: FireSignalKind;
  intensity: number; // 0.0 - 1.0
  ts: number;
  emotion: Readonly<EmotionVector>;
}

// ---- Receptor state ----

export interface ReceptorState {
  watching: boolean;
  startedAt: number | null;
  eventCount: number;
  lastEmotion: EmotionVector;
  signals: FireSignal[];
}

// ---- Path heatmap node ----

export interface HeatNode {
  count: number;
  children: Map<string, HeatNode>;
}

// ---- Commander time window ----

export interface TimeWindow {
  events: NormalizedEvent[];
  windowMs: number;
}