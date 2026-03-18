// ============================================================
// Pre-Neuron — Staleness Detector
// ============================================================
// Detects file staleness via multi-index HeatNode comparison.
// 3-stage scope expansion: siblings → ancestors → filenameIndex.
// Called by PathHeatmap.record() when lightweight check triggers.

import type { HeatNode, AgentState } from "../receptor/types.js";
import { shadowIndexConfig as cfg } from "../receptor/shadow-index-config.js";
import { pushAlert } from "./index.js";
import type { PathHeatmap } from "../receptor/heatmap.js";

// ---- Signal types ----

export interface StalenessSignal {
  openedFile: string;
  newerSibling: string;
  timeDelta: number;
  siblingCount: number;
  totalOpened: number;
  totalModified: number;
  pattern: "repeated-trap" | "blind-spot";
  stage: 1 | 2 | 3;
}

// ---- Levenshtein distance (basename only) ----

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

// ---- Core detection ----

/**
 * Run staleness detection for a just-accessed file path.
 * Returns the first signal found across 3 stages, or null if clean.
 */
export function detectStaleness(
  openedPath: string,
  heatmap: PathHeatmap,
): StalenessSignal | null {
  const node = heatmap.getNode(openedPath);
  if (!node) return null;

  // Stage 1: siblings
  const stage1 = checkSiblings(openedPath, node, heatmap, 1);
  if (stage1) return stage1;

  // Stage 2: ancestors (up to ancestorDepth)
  for (let depth = 2; depth <= cfg.ancestorDepth + 1; depth++) {
    const ancestorInfo = heatmap.ancestor(openedPath, depth);
    if (!ancestorInfo) break;
    const stage2 = checkDescendants(openedPath, node, ancestorInfo.node, 2);
    if (stage2) return stage2;
  }

  // Stage 3: filenameIndex (cross-tree)
  return checkFilenameIndex(openedPath, node, heatmap);
}

// ---- Stage 1: Sibling comparison ----

function checkSiblings(
  openedPath: string,
  node: HeatNode,
  heatmap: PathHeatmap,
  stage: 1 | 2,
): StalenessSignal | null {
  const siblings = heatmap.siblings(openedPath);
  if (!siblings || siblings.size < cfg.minSiblingCount) return null;

  return analyzeGroup(openedPath, node, siblings, stage);
}

// ---- Stage 2: Ancestor descendants ----

function checkDescendants(
  openedPath: string,
  node: HeatNode,
  ancestorNode: HeatNode,
  stage: 1 | 2,
): StalenessSignal | null {
  // Collect all leaves under this ancestor
  const leaves = new Map<string, HeatNode>();
  collectLeaves(ancestorNode, [], leaves);

  if (leaves.size < cfg.minSiblingCount) return null;

  return analyzeGroup(openedPath, node, leaves, stage);
}

function collectLeaves(
  node: HeatNode,
  segments: string[],
  out: Map<string, HeatNode>,
): void {
  if (node.children.size === 0 && segments.length > 0) {
    out.set(segments.join("/"), node);
    return;
  }
  for (const [seg, child] of node.children) {
    collectLeaves(child, [...segments, seg], out);
  }
}

// ---- Stage 3: Filename index (cross-tree) ----

function checkFilenameIndex(
  openedPath: string,
  node: HeatNode,
  heatmap: PathHeatmap,
): StalenessSignal | null {
  const segments = openedPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const basename = segments[segments.length - 1];
  if (!basename) return null;

  const filenameIdx = heatmap.filenameIndex;

  // Exact match
  const exactSet = filenameIdx.get(basename);
  if (exactSet && exactSet.size >= 2) {
    const group = new Map<string, HeatNode>();
    for (const p of exactSet) {
      const n = heatmap.getNode(p);
      if (n) group.set(p, n);
    }
    if (group.size >= 2) {
      const result = analyzeGroup(openedPath, node, group, 3);
      if (result) return result;
    }
  }

  // Levenshtein fuzzy match
  const candidates = new Map<string, HeatNode>();
  for (const [name, paths] of filenameIdx) {
    if (name === basename) continue;
    if (levenshtein(basename, name) <= cfg.levenshteinThreshold) {
      for (const p of paths) {
        const n = heatmap.getNode(p);
        if (n) candidates.set(p, n);
      }
    }
  }

  if (candidates.size === 0) return null;

  // Add the opened file itself for group analysis
  candidates.set(openedPath, node);
  if (candidates.size < 2) return null;

  return analyzeGroup(openedPath, node, candidates, 3);
}

// ---- Shared analysis: multi-dimensional cross check ----

function analyzeGroup(
  openedPath: string,
  node: HeatNode,
  group: Map<string, HeatNode>,
  stage: 1 | 2 | 3,
): StalenessSignal | null {
  // Filter: only nodes with lastModified set
  const withMtime: Array<{ path: string; node: HeatNode }> = [];
  for (const [p, n] of group) {
    if (n.lastModified > 0) withMtime.push({ path: p, node: n });
  }
  if (withMtime.length < cfg.minSiblingCount) return null;

  // Node must have lastModified
  if (node.lastModified === 0) return null;

  // Sort by lastModified descending
  withMtime.sort((a, b) => b.node.lastModified - a.node.lastModified);

  const newest = withMtime[0];
  const cutoffIndex = Math.max(0, Math.floor(withMtime.length * (1 - cfg.stalenessPercentile)));
  const isStale = withMtime.findIndex((e) => e.path === openedPath) >= cutoffIndex;

  if (!isStale) return null;

  // Time delta check
  const timeDelta = newest.node.lastModified - node.lastModified;
  if (timeDelta < cfg.minTimeDelta) return null;

  // State multiplier — deep_work reduces sensitivity
  const multiplier = cfg.stateMultipliers[node.lastTouchedState] ?? 1.0;
  if (multiplier < 0.2) return null; // deep_work nearly suppresses

  // Pattern classification via multi-dimensional cross analysis
  const pattern = classifyPattern(node, group);
  if (!pattern) return null;

  const signal: StalenessSignal = {
    openedFile: openedPath,
    newerSibling: newest.path,
    timeDelta,
    siblingCount: withMtime.length,
    totalOpened: node.totalOpened,
    totalModified: node.totalModified,
    pattern,
    stage,
  };

  // Emit to pre-neuron alert layer
  const severity = pattern === "blind-spot" ? "warn" as const : "info" as const;
  const shortPath = openedPath.split("/").slice(-2).join("/");
  const newerShort = newest.path.split("/").slice(-2).join("/");
  const deltaH = Math.round(timeDelta / 3600000);

  pushAlert({
    source: "staleness-detector",
    severity,
    message: pattern === "blind-spot"
      ? `${newerShort} (modified ${deltaH}h newer) not in view`
      : `${shortPath} opened ${node.totalOpened}x but never edited — ${newerShort} is ${deltaH}h newer`,
  });

  return signal;
}

// ---- Pattern classification ----

function classifyPattern(
  node: HeatNode,
  group: Map<string, HeatNode>,
): "repeated-trap" | "blind-spot" | null {
  // repeated-trap: high opened, low modified (agent keeps reading but not editing)
  if (node.totalOpened >= 3 && node.totalModified === 0) {
    return "repeated-trap";
  }

  // blind-spot: a sibling with high totalModified that the agent hasn't opened
  for (const [, sibling] of group) {
    if (sibling === node) continue;
    if (sibling.totalModified >= 3 && sibling.totalOpened === 0) {
      return "blind-spot";
    }
  }

  // Softer blind-spot: newest sibling was never opened
  let newestMtime = 0;
  let newestNode: HeatNode | null = null;
  for (const [, sibling] of group) {
    if (sibling.lastModified > newestMtime) {
      newestMtime = sibling.lastModified;
      newestNode = sibling;
    }
  }
  if (newestNode && newestNode !== node && newestNode.totalOpened === 0) {
    return "blind-spot";
  }

  return null;
}
