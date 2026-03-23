// ============================================================
// Experience Package — Persona (body) + Prior Block (memory)
// ============================================================
// Unified cross-session continuity package.
//
//   Persona:     身体性 — 感度、閾値、行動傾向（時間を持たない）
//   Prior Block: 前世記憶 — 体験の arc（時間の中にある）
//
// Sphere Node L1-L4 mapping:
//   L1 tags:    空間座標 + フィルタ
//   L2 summary: ラベル（ベクトル化対象ではない、Sphere Tagger がタグからベクトル付与）
//   L3 content: Package 本体（Data Cost Protocol compact JSON）
//   L4 links:   engram nodeId 参照
//
// Design: docs/PERSONA_LOADING_SYSTEM.md

import type { Persona } from "./persona-snapshot.js";
import type { AgentState } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Prior Block types (mirrored from persona-prior.ts to avoid circular dep) ----

type PriorElement = unknown[]; // H, A, F tuples or ["---"] separator
type PriorBlock = PriorElement[];

// ---- Experience Package ----

export interface ExperiencePackageLabel {
  dominantAxis: string;
  dominantState: string;
  durationMs: number;
  stateFlow: string;
  valenceBalance: number;
  meanIntensity: number;
  snapshotCount: number;
}

export interface ExperiencePackage {
  $schema: "experience-package-v1";
  ts: number;

  // Compatibility (pre-load validation)
  origin: {
    model: string;
    profileHash: string;
  };

  // Showcase label (readable without opening the package)
  label: ExperiencePackageLabel;

  // Filter
  context?: {
    techStack?: string[];
    domain?: string[];
    projectId?: string;
  };

  // Payload
  persona: Persona;
  priorBlock: PriorBlock;
}

// ---- Sink path ----

const OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const PACKAGE_PATH = path.join(OUTPUT_DIR, "experience-package.json");

/**
 * Build an Experience Package from finalized Persona + Prior Block.
 * Returns null if either component is missing.
 */
export function buildPackage(
  persona: Persona,
  priorBlock: PriorBlock,
  stateFlow: string,
  valenceBalance: number,
  meanIntensity: number,
  projectId?: string,
): ExperiencePackage {
  // Extract dominant state from persona's stateDistribution
  const stateEntries = Object.entries(persona.stateDistribution) as [string, number][];
  const dominantState = stateEntries.reduce((a, b) => b[1] > a[1] ? b : a, stateEntries[0])?.[0] ?? "idle";

  const pkg: ExperiencePackage = {
    $schema: "experience-package-v1",
    ts: Date.now(),
    origin: {
      model: persona.origin.model,
      profileHash: persona.origin.profileHash,
    },
    label: {
      dominantAxis: persona.emotionProfile.dominantAxis,
      dominantState,
      durationMs: persona.sessionMeta.elapsedMs,
      stateFlow,
      valenceBalance,
      meanIntensity,
      snapshotCount: persona.sessionMeta.snapshotCount,
    },
    persona,
    priorBlock,
  };

  // Attach context if available
  const ctx: ExperiencePackage["context"] = {};
  if (persona.workContext.techStack?.length) ctx.techStack = persona.workContext.techStack;
  if (persona.workContext.domain?.length) ctx.domain = persona.workContext.domain;
  if (projectId) ctx.projectId = projectId;
  if (Object.keys(ctx).length > 0) pkg.context = ctx;

  return pkg;
}

/**
 * Save Experience Package to local sink (overwrite — latest session only).
 */
export function savePackage(pkg: ExperiencePackage): void {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n");
    console.error(
      `[experience-package] saved: ${pkg.label.dominantAxis}/${pkg.label.dominantState} ` +
      `${Math.round(pkg.label.durationMs / 60000)}m ${pkg.label.snapshotCount} snaps`,
    );
  } catch (err) {
    console.error("[experience-package] save error:", err);
  }
}

/**
 * Load the latest Experience Package from local sink.
 * Returns null if no package exists or data is corrupt.
 */
export function loadPackage(): ExperiencePackage | null {
  try {
    if (!fs.existsSync(PACKAGE_PATH)) return null;
    const raw = fs.readFileSync(PACKAGE_PATH, "utf-8").trim();
    if (!raw) return null;
    const pkg = JSON.parse(raw) as ExperiencePackage;
    if (pkg.$schema !== "experience-package-v1") return null;
    return pkg;
  } catch {
    return null;
  }
}