// ============================================================
// Receptor — Action Logger
// ============================================================
// Records behavioral keypoints (state transitions, entropy spikes)
// as embedded vectors in Qdrant `action_log` collection.
//
// Embed target: semantic label string (no paths, no raw numbers).
//   Format: "[techStack] [workType], [transition], [entropyLabel]"
//   e.g. "typescript editing, stuck to exploring, switching"
//
// Payload (separate from embed): emotion, state, entropy, paths, ts.
// This separation ensures vectors are Sphere-compatible (no project-
// specific data baked into embeddings) while retaining full detail
// in payload for local post-filtering.
//
// Design: RECEPTOR_ARCHITECTURE.md §12

import { randomUUID } from "node:crypto";
import type { EmotionVector, AgentState, PatternKind } from "./types.js";

// ---- Config ----

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = "action_log";
const VECTOR_DIM = 384;

// ---- State tracking (for keypoint detection) ----

let _prevState: AgentState | null = null;
let _prevEntropy = 0;
let _initialized = false;

// ---- Label maps (AgentState/PatternKind → natural language for MiniLM) ----

const STATE_LABELS: Record<AgentState, string> = {
  deep_work: "deep work",
  exploring: "exploring",
  stuck: "stuck",
  idle: "idle",
  delegating: "delegating",
};

const PATTERN_LABELS: Record<PatternKind, string> = {
  implementation: "editing",
  exploration: "reading",
  trial_error: "debugging",
  wandering: "searching",
  delegation: "delegating",
  stagnation: "idle",
};

function entropyLabel(entropy: number): string {
  if (entropy < 1.0) return "focused";
  if (entropy < 2.0) return "switching";
  return "scattered";
}

function buildTransition(prev: AgentState | null, current: AgentState): string {
  if (!prev || prev === current) return STATE_LABELS[current];
  return `${STATE_LABELS[prev]} to ${STATE_LABELS[current]}`;
}

// ---- Collection init ----

async function ensureCollection(): Promise<void> {
  if (_initialized) return;
  try {
    const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!check.ok) {
      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vectors: { size: VECTOR_DIM, distance: "Cosine" },
        }),
      });
      if (!res.ok) {
        console.error(`[action-logger] collection create failed: ${res.status}`);
        return;
      }
      // Create payload indexes
      for (const [field, schema] of [
        ["state", "keyword"],
        ["projectId", "keyword"],
        ["ts", "integer"],
      ] as const) {
        await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field_name: field, field_schema: schema }),
        });
      }
      console.error(`[action-logger] collection "${COLLECTION}" created`);
    }
    _initialized = true;
  } catch (err) {
    console.error(`[action-logger] init error:`, err);
  }
}

// ---- Embedding via gateway ----

async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { vector: number[] };
    return data.vector;
  } catch {
    return null;
  }
}

// ---- Keypoint detection ----

export interface ActionSnapshot {
  topPaths: string[];
  emotion: EmotionVector;
  agentState: AgentState;
  pattern: PatternKind;
  entropy: number;
  techStack?: string[];
  projectId?: string;
}

/**
 * Determine if current state is a keypoint worth recording.
 * Keypoints: state transitions, entropy spikes (>0.2 delta).
 */
export function isKeypoint(snap: ActionSnapshot): boolean {
  // State transition
  if (_prevState !== null && snap.agentState !== _prevState) {
    return true;
  }
  // Entropy spike (absolute delta > 0.2)
  if (Math.abs(snap.entropy - _prevEntropy) > 0.2) {
    return true;
  }
  // First event
  if (_prevState === null) {
    return true;
  }
  return false;
}

// ---- Record ----

/**
 * Record an action keypoint to Qdrant.
 *
 * Embed target (search key): semantic labels only — no paths, no numbers.
 *   "[techStack] [workType], [transition], [entropyLabel]"
 * Payload (record): full detail for post-filtering.
 */
export async function recordAction(snap: ActionSnapshot): Promise<void> {
  // Update tracking state (before early return)
  const prev = _prevState;
  const wasKeypoint = isKeypoint(snap);
  _prevState = snap.agentState;
  _prevEntropy = snap.entropy;

  if (!wasKeypoint) return;

  // Build semantic label for embedding (Sphere-compatible, no paths)
  const parts: string[] = [];

  // techStack first — highest vector discrimination
  if (snap.techStack && snap.techStack.length > 0) {
    parts.push(snap.techStack.join(" "));
  }

  // workType from pattern
  parts.push(PATTERN_LABELS[snap.pattern]);

  // State transition
  const transition = buildTransition(prev, snap.agentState);
  parts.push(transition);

  // Entropy label
  parts.push(entropyLabel(snap.entropy));

  const embedText = parts.join(", ");

  // Ensure collection exists
  await ensureCollection();

  // Embed
  const vector = await embed(embedText);
  if (!vector) {
    console.error("[action-logger] embedding failed, skipping");
    return;
  }

  // Payload: full detail for local post-filtering (paths, emotion, etc.)
  const pathParts = snap.topPaths.slice(0, 5).map(p => {
    const segs = p.split("/");
    return segs.slice(-2).join("/");
  });

  const id = randomUUID();
  const payload = {
    text: embedText,
    paths: pathParts,
    emotion: snap.emotion,
    state: snap.agentState,
    pattern: snap.pattern,
    entropy: snap.entropy,
    ts: Date.now(),
    projectId: snap.projectId || "unknown",
  };

  try {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [{ id, vector, payload }] }),
    });
    if (res.ok) {
      console.error(`[action-logger] recorded: ${embedText}`);
    }
  } catch (err) {
    console.error(`[action-logger] upsert error:`, err);
  }
}

/** Reset state (for testing). */
export function clearActionLogger(): void {
  _prevState = null;
  _prevEntropy = 0;
  _initialized = false;
}
