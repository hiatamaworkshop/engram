// ============================================================
// Receptor — Action Logger
// ============================================================
// Records behavioral keypoints (state transitions, entropy spikes)
// as embedded vectors in Qdrant `action_log` collection.
//
// Runs as a passive receptor method (receptor-rules.json: action_logger).
// Uses gateway /embed endpoint for MiniLM embedding,
// then writes directly to Qdrant REST API.
//
// Data structure per point:
//   vector: MiniLM(action text summary) [384d]
//   payload: { text, emotion, state, entropy, ts, projectId }

import { randomUUID } from "node:crypto";
import type { EmotionVector, AgentState } from "./types.js";

// ---- Config ----

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = "action_log";
const VECTOR_DIM = 384;

// ---- State tracking (for keypoint detection) ----

let _prevState: AgentState | null = null;
let _prevEntropy = 0;
let _initialized = false;

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
  entropy: number;
  projectId?: string;
}

/**
 * Determine if current state is a keypoint worth recording.
 * Keypoints: state transitions, entropy spikes (>0.5 delta).
 */
export function isKeypoint(snap: ActionSnapshot): boolean {
  // State transition
  if (_prevState !== null && snap.agentState !== _prevState) {
    return true;
  }
  // Entropy spike (absolute delta > 0.5)
  if (Math.abs(snap.entropy - _prevEntropy) > 0.5) {
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
 * Called by the action_logger executor (registered in index.ts).
 */
export async function recordAction(snap: ActionSnapshot): Promise<void> {
  // Update tracking state
  const wasKeypoint = isKeypoint(snap);
  _prevState = snap.agentState;
  _prevEntropy = snap.entropy;

  if (!wasKeypoint) return;

  // Build action text summary for embedding
  const pathParts = snap.topPaths.slice(0, 5).map(p => {
    const segs = p.split("/");
    return segs.slice(-2).join("/");
  });
  const text = `${snap.agentState} ${pathParts.join(", ")} entropy=${snap.entropy.toFixed(1)}`;

  // Ensure collection exists
  await ensureCollection();

  // Embed
  const vector = await embed(text);
  if (!vector) {
    console.error("[action-logger] embedding failed, skipping");
    return;
  }

  // Upsert to Qdrant
  const id = randomUUID();
  const payload = {
    text,
    emotion: snap.emotion,
    state: snap.agentState,
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
      console.error(`[action-logger] recorded: ${snap.agentState} entropy=${snap.entropy.toFixed(2)}`);
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