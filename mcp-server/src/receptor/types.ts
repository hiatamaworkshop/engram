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
  eventId: number;
  action: NormalizedAction;
  path?: string;
  result?: "success" | "failure" | "empty";
  ts: number;
}

// ---- Emotion vector (5-axis) ----

export interface EmotionVector {
  frustration: number; // negative: stuck, no solution visible
  seeking: number;     // positive=curiosity (exploring after success), negative=desperation (searching after failure)
  confidence: number;  // positive: hypothesis confirmed
  fatigue: number;     // meta: cognitive load accumulation
  flow: number;        // positive: thought and action aligned
}

export const ZERO_EMOTION: Readonly<EmotionVector> = {
  frustration: 0,
  seeking: 0,
  confidence: 0,
  fatigue: 0,
  flow: 0,
};

export type EmotionAxis = keyof EmotionVector;

// ---- Commander pattern classification ----

export type PatternKind =
  | "exploration"     // Read+Grep high, Edit low → seeking (sign from context)
  | "implementation"  // Edit+Bash high, Grep low → flow/confidence
  | "trial_error"     // Edit→Bash alternating → frustration
  | "wandering"       // Grep+Read high, Edit 0 → seeking (negative)
  | "delegation"      // Agent high → isolation
  | "stagnation";     // all low → fatigue

// ---- Agent state (derived by Meta neuron C) ----

export type AgentState =
  | "deep_work"    // flow state, implementation pattern, low frustration
  | "exploring"    // reading/searching, not editing
  | "stuck"        // high frustration, trial_error pattern
  | "idle"         // silence gate active (no recent events)
  | "delegating";  // agent calls dominate

// ---- Fire signal (emotion → connection target) ----

export type FireSignalKind =
  | "frustration_spike"
  | "seeking_spike"
  | "confidence_sustained"
  | "fatigue_rising"
  | "flow_active"
  | "compound_frustration_seeking";

export interface FireSignal {
  kind: FireSignalKind;
  intensity: number; // 0.0 - 1.0
  ts: number;
  emotion: Readonly<EmotionVector>;
  agentState: AgentState;
  pattern: PatternKind;
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

export interface HeatmapSnapshot {
  ts: number;
  totalHits: number;
  topPaths: Array<{ path: string; count: number }>;
}

// ---- Commander time window ----

export interface TimeWindow {
  events: NormalizedEvent[];
  windowMs: number;
}

// ---- Project metadata (Sphere routing) ----
// Used by sphere-shaper to attach domain context to centroid payloads.
// projectId is NOT included — anonymization strips it.
// techStack + domain survive anonymization because they are categorical,
// not identifying. Facade resolves domain → Sphere internally (DNS-like).
// Agents never see individual Sphere endpoints — only Facade URL.

export interface ProjectMeta {
  techStack: string[];   // e.g. ["typescript", "qdrant", "docker"]
  domain: string[];      // e.g. ["ai-agent", "memory-system"]
  facadeUrl?: string;    // single entry point — Facade handles Sphere resolution
}