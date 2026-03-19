// ============================================================
// Receptor — Path Heatmap (Multi-Index)
// ============================================================
// Tracks file access as a multi-dimensional weighted tree.
// Each leaf node carries 6 index axes for staleness detection.
// Directory nodes aggregate count only (structural property).
//
// Lifecycle: Active HeatNode → Index Vector → engram/sink 退避
// Time decay uses cumulative work-time (idle gaps skipped).

import type { HeatNode, NormalizedEvent, HeatmapSnapshot, AgentState, IndexVector } from "./types.js";
import { shadowIndexConfig as cfg } from "./shadow-index-config.js";

function createNode(): HeatNode {
  return {
    count: 0,
    totalOpened: 0,
    totalModified: 0,
    lastModified: 0,
    lastAccess: 0,
    lastTouchedState: "idle",
    children: new Map(),
  };
}

export class PathHeatmap {
  private root: HeatNode = createNode();
  private _totalHits = 0;
  private _previousTop: string[] = [];

  /** Reverse filename index: basename → set of full paths */
  private _filenameIndex: Map<string, Set<string>> = new Map();

  /** Current agent state — set externally by receptor index before record() */
  private _agentState: AgentState = "idle";

  /** Callback for lastModified async fill (fire-and-forget) */
  private _statProvider: ((path: string) => Promise<number>) | null = null;

  // ---- Work-time window (Digestor 作法) ----

  /** First record() timestamp — for active ratio calculation */
  private _firstRecordTs = 0;

  /** Last activity timestamp — updated on every record() */
  private _lastActivityTs = 0;

  /** Cumulative active time in ms (idle gaps excluded) */
  private _cumulativeActiveMs = 0;

  /** Per-leaf: maps path → cumulative active time at last access */
  private _leafActiveTime: Map<string, number> = new Map();

  /** Index Vectors: compressed expired HeatNodes */
  private _indexVectors: IndexVector[] = [];

  /** Callback for Index Vector sink (set externally for engram/sink integration) */
  private _onExpire: ((vectors: IndexVector[]) => void) | null = null;

  set agentState(s: AgentState) { this._agentState = s; }
  get agentState(): AgentState { return this._agentState; }

  /** Register an async fs.stat provider for lastModified. */
  setStatProvider(fn: (path: string) => Promise<number>): void {
    this._statProvider = fn;
  }

  /** Register a callback for expired Index Vectors (engram/sink integration). */
  setExpireHandler(fn: (vectors: IndexVector[]) => void): void {
    this._onExpire = fn;
  }

  /** Current cumulative active time. */
  get cumulativeActiveMs(): number { return this._cumulativeActiveMs; }

  /** Accumulated Index Vectors (read-only). */
  get indexVectors(): ReadonlyArray<IndexVector> { return this._indexVectors; }

  /** Record a file access. Only file_read, file_edit, search count. */
  record(event: NormalizedEvent): void {
    if (!event.path) return;
    if (event.action !== "file_read" && event.action !== "file_edit" && event.action !== "search") return;

    const segments = event.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length === 0) return;

    const now = event.ts || Date.now();

    // ---- Work-time window: accumulate active time, skip idle gaps ----
    if (this._firstRecordTs === 0) this._firstRecordTs = now;
    if (this._lastActivityTs > 0) {
      const gap = now - this._lastActivityTs;
      if (gap < cfg.idleThresholdMs) {
        // Within active window — accumulate
        this._cumulativeActiveMs += gap;
      }
      // else: idle gap — skip (time doesn't advance)
    }
    this._lastActivityTs = now;

    this._totalHits++;
    let node = this.root;
    node.count++;

    for (const seg of segments) {
      if (!node.children.has(seg)) {
        node.children.set(seg, createNode());
      }
      node = node.children.get(seg)!;
      node.count++;
    }

    // Leaf-only multi-axis updates
    node.lastAccess = now;
    node.lastTouchedState = this._agentState;

    if (event.action === "file_read") {
      node.totalOpened++;
    }
    if (event.action === "file_edit") {
      node.totalModified++;
    }

    // Track cumulative active time at leaf level
    const fullPath = segments.join("/");
    this._leafActiveTime.set(fullPath, this._cumulativeActiveMs);

    // Update filenameIndex (basename → full paths)
    const basename = segments[segments.length - 1];
    this._updateFilenameIndex(basename, fullPath);

    // Fire-and-forget lastModified via stat provider
    if (this._statProvider && (event.action === "file_read" || event.action === "file_edit")) {
      this._statProvider(event.path).then((mtime) => {
        if (mtime > 0) node.lastModified = mtime;
      }).catch(() => { /* stat failure is safe to ignore */ });
    }
  }

  // ---- Time decay (work-time based) ----

  /** Effective count with exponential time decay based on cumulative work-time. */
  effectiveCount(node: HeatNode, now?: number): number {
    if (node.lastAccess === 0) return node.count;
    // Use work-time delta instead of wall-clock delta
    const wallDt = (now ?? Date.now()) - node.lastAccess;
    // If we have lastActivityTs, estimate work-time portion of wallDt
    const workDt = this._estimateWorkTime(node.lastAccess, wallDt);
    return node.count * Math.exp(-workDt / cfg.halfLife);
  }

  /**
   * Estimate cumulative work-time since a given timestamp.
   * Uses the ratio of cumulative active time to total wall time.
   * Falls back to wall-clock when insufficient data.
   */
  private _estimateWorkTime(sinceTs: number, wallDt: number): number {
    // If no activity tracking or only one event, fall back to wall-clock
    if (this._lastActivityTs === 0 || this._cumulativeActiveMs === 0) return wallDt;

    // Active ratio = cumulative active / total wall elapsed
    // _firstRecordTs tracks the very first record() call
    const totalWall = this._lastActivityTs - this._firstRecordTs;
    if (totalWall <= 0) return wallDt;

    const activeRatio = Math.min(1, this._cumulativeActiveMs / totalWall);
    return wallDt * activeRatio;
  }

  // ---- Metabolism: expire check + Index Vector compression ----

  /**
   * Run metabolism: check all leaves for activeWindow expiry.
   * Expired nodes are compressed to Index Vectors and removed.
   * Returns count of expired nodes.
   */
  runMetabolism(): number {
    const leaves: Array<{ path: string; node: HeatNode }> = [];
    this._collectLeavesWithNodes(this.root, [], leaves);

    const expired: IndexVector[] = [];
    const pathsToRemove: string[] = [];

    for (const { path, node } of leaves) {
      const leafActiveAt = this._leafActiveTime.get(path) ?? 0;
      const activeAge = this._cumulativeActiveMs - leafActiveAt;

      if (activeAge >= cfg.activeWindow) {
        // Compress to Index Vector
        const vector = this._compressToIndexVector(path, node, leaves);
        if (vector) {
          expired.push(vector);
        }
        pathsToRemove.push(path);
      }
    }

    // Remove expired nodes from tree
    for (const p of pathsToRemove) {
      this._removeLeaf(p);
      this._leafActiveTime.delete(p);
      // filenameIndex: keep entry (Index Vector still references the path)
    }

    // Add to index vectors store
    if (expired.length > 0) {
      this._indexVectors.push(...expired);
      this._enforceIndexVectorLimits();

      // Notify expire handler (engram/sink)
      if (this._onExpire) {
        try { this._onExpire(expired); } catch { /* handler must not crash heatmap */ }
      }
    }

    return pathsToRemove.length;
  }

  /**
   * Compress a HeatNode to a 6-dimensional Index Vector.
   * Each axis is percentile-normalized within its sibling group.
   */
  private _compressToIndexVector(
    leafPath: string,
    node: HeatNode,
    allLeaves: Array<{ path: string; node: HeatNode }>,
  ): IndexVector | null {
    // Find siblings for percentile normalization
    const segments = leafPath.split("/");
    const parentPath = segments.slice(0, -1).join("/");
    const siblings = allLeaves.filter((l) => {
      const lParent = l.path.split("/").slice(0, -1).join("/");
      return lParent === parentPath;
    });

    if (siblings.length === 0) return null;

    // Percentile for each axis (0.0 = lowest among siblings, 1.0 = highest)
    const percentile = (values: number[], target: number): number => {
      if (values.length <= 1) return 0.5;
      const sorted = [...values].sort((a, b) => a - b);
      const idx = sorted.indexOf(target);
      return idx / (sorted.length - 1);
    };

    const counts = siblings.map((s) => s.node.count);
    const opens = siblings.map((s) => s.node.totalOpened);
    const mods = siblings.map((s) => s.node.totalModified);
    const mtimes = siblings.filter((s) => s.node.lastModified > 0).map((s) => s.node.lastModified);
    const accesses = siblings.map((s) => s.node.lastAccess);
    // lastTouchedState → numeric: deep_work=4, stuck=3, delegating=2, exploring=1, idle=0
    const stateNum = (s: AgentState): number =>
      s === "deep_work" ? 4 : s === "stuck" ? 3 : s === "delegating" ? 2 : s === "exploring" ? 1 : 0;
    const states = siblings.map((s) => stateNum(s.node.lastTouchedState));

    const vector = [
      percentile(counts, node.count),
      percentile(opens, node.totalOpened),
      percentile(mods, node.totalModified),
      mtimes.length > 0 ? percentile(mtimes, node.lastModified) : 0.5,
      percentile(accesses, node.lastAccess),
      percentile(states, stateNum(node.lastTouchedState)),
    ];

    return {
      path: leafPath,
      vector,
      lastSeen: node.lastAccess,
      trapCount: 0,
    };
  }

  /** Remove a leaf node from the tree (and prune empty parents). */
  private _removeLeaf(leafPath: string): void {
    const segments = leafPath.split("/").filter(Boolean);
    if (segments.length === 0) return;

    // Walk down, collecting parent chain
    const chain: Array<{ parent: HeatNode; key: string }> = [];
    let node = this.root;
    for (const seg of segments) {
      const child = node.children.get(seg);
      if (!child) return; // already removed
      chain.push({ parent: node, key: seg });
      node = child;
    }

    // Remove leaf
    const last = chain[chain.length - 1];
    last.parent.children.delete(last.key);

    // Prune empty parents bottom-up
    for (let i = chain.length - 2; i >= 0; i--) {
      const entry = chain[i];
      const child = entry.parent.children.get(entry.key);
      if (child && child.children.size === 0 && child.count === 0) {
        entry.parent.children.delete(entry.key);
      } else {
        break;
      }
    }
  }

  /** Enforce Index Vector limits (maxCount + TTL). */
  private _enforceIndexVectorLimits(): void {
    const now = Date.now();

    // TTL expiry
    this._indexVectors = this._indexVectors.filter((v) => {
      if (now - v.lastSeen > cfg.indexVectorTTL) {
        // Also remove from filenameIndex
        this._removeFromFilenameIndex(v.path);
        return false;
      }
      return true;
    });

    // LRU: sort by lastSeen, drop oldest beyond maxCount
    if (this._indexVectors.length > cfg.indexVectorMaxCount) {
      this._indexVectors.sort((a, b) => b.lastSeen - a.lastSeen);
      const dropped = this._indexVectors.splice(cfg.indexVectorMaxCount);
      for (const v of dropped) {
        this._removeFromFilenameIndex(v.path);
      }
    }
  }

  /** Remove a path from filenameIndex. */
  private _removeFromFilenameIndex(fullPath: string): void {
    const basename = fullPath.split("/").pop();
    if (!basename) return;
    const paths = this._filenameIndex.get(basename);
    if (paths) {
      paths.delete(fullPath);
      if (paths.size === 0) this._filenameIndex.delete(basename);
    }
  }

  /** Increment trap count on an Index Vector by path. Returns true if found. */
  incrementTrapCount(path: string): boolean {
    const vec = this._indexVectors.find((v) => v.path === path);
    if (vec) {
      vec.trapCount++;
      return true;
    }
    return false;
  }

  // ---- Queries ----

  /** Get top N hottest leaf paths (with time decay). */
  topPaths(n: number): Array<{ path: string; count: number }> {
    const now = Date.now();
    const leaves: Array<{ path: string; count: number }> = [];
    this._collectLeaves(this.root, [], leaves, now);
    leaves.sort((a, b) => b.count - a.count);
    return leaves.slice(0, n);
  }

  /** Detect if hot paths changed significantly since last check. */
  detectShift(topN = 5): { shifted: boolean; newPaths: string[] } {
    const current = this.topPaths(topN).map((p) => p.path);
    const newPaths = current.filter((p) => !this._previousTop.includes(p));
    const shifted = newPaths.length >= Math.ceil(topN / 2);
    this._previousTop = current;
    return { shifted, newPaths };
  }

  /** Check if a path has never been accessed before. */
  isFirstAccess(path: string): boolean {
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
    let node = this.root;
    for (const seg of segments) {
      const child = node.children.get(seg);
      if (!child) return true;
      node = child;
    }
    return node.count <= 1;
  }

  /** Serializable snapshot of current heatmap state. */
  snapshot(topN = 15): HeatmapSnapshot {
    return {
      ts: Date.now(),
      totalHits: this._totalHits,
      topPaths: this.topPaths(topN),
    };
  }

  get totalHits(): number {
    return this._totalHits;
  }

  /** Shannon entropy of file access distribution. */
  entropy(topN = 20): number {
    const leaves = this.topPaths(topN);
    if (leaves.length === 0) return 0;
    const total = leaves.reduce((s, l) => s + l.count, 0);
    if (total === 0) return 0;
    let h = 0;
    for (const { count } of leaves) {
      const p = count / total;
      if (p > 0) h -= p * Math.log2(p);
    }
    return h;
  }

  // ---- Tree access (for StalenessDetector) ----

  /** Resolve a path to its HeatNode. Returns undefined if not found. */
  getNode(path: string): HeatNode | undefined {
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
    let node = this.root;
    for (const seg of segments) {
      const child = node.children.get(seg);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  /** Get parent node's children (siblings of the given path). */
  siblings(path: string): Map<string, HeatNode> | undefined {
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length === 0) return undefined;
    let node = this.root;
    // Navigate to parent
    for (let i = 0; i < segments.length - 1; i++) {
      const child = node.children.get(segments[i]);
      if (!child) return undefined;
      node = child;
    }
    return node.children;
  }

  /** Get ancestor node at given depth above the target path. */
  ancestor(path: string, depth: number): { node: HeatNode; basePath: string } | undefined {
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
    const targetDepth = segments.length - 1 - depth; // parent = depth 1
    if (targetDepth < 0) return undefined;
    let node = this.root;
    for (let i = 0; i < targetDepth; i++) {
      const child = node.children.get(segments[i]);
      if (!child) return undefined;
      node = child;
    }
    return { node, basePath: segments.slice(0, targetDepth).join("/") };
  }

  /** Access the filenameIndex (read-only for StalenessDetector). */
  get filenameIndex(): ReadonlyMap<string, ReadonlySet<string>> {
    return this._filenameIndex;
  }

  /** Shadow Index status snapshot for display. */
  shadowIndexStatus(): string {
    // Count leaf nodes and collect multi-index stats
    const leaves: Array<{ path: string; node: HeatNode }> = [];
    this._collectLeavesWithNodes(this.root, [], leaves);

    if (leaves.length === 0 && this._indexVectors.length === 0) return "Shadow Index: empty";

    const withMtime = leaves.filter((l) => l.node.lastModified > 0);
    const totalFilenames = this._filenameIndex.size;

    const activeMs = Math.round(this._cumulativeActiveMs / 1000);
    const activeMins = Math.round(activeMs / 60);

    const lines: string[] = [
      `Shadow Index: ${leaves.length} active, ${this._indexVectors.length} vectors, ${totalFilenames} basenames, work:${activeMins}m`,
    ];

    // Show top 5 most-opened leaves
    const byOpened = [...leaves].sort((a, b) => b.node.totalOpened - a.node.totalOpened).slice(0, 5);
    if (byOpened.length > 0 && byOpened[0].node.totalOpened > 0) {
      lines.push("  most opened:");
      for (const { path, node } of byOpened) {
        if (node.totalOpened === 0) break;
        const short = path.split("/").slice(-3).join("/");
        lines.push(`    ${short}  opened:${node.totalOpened} modified:${node.totalModified} state:${node.lastTouchedState}`);
      }
    }

    // Show filenames with multiple paths (collision candidates)
    const collisions: Array<{ name: string; count: number }> = [];
    for (const [name, paths] of this._filenameIndex) {
      if (paths.size >= 2) collisions.push({ name, count: paths.size });
    }
    if (collisions.length > 0) {
      collisions.sort((a, b) => b.count - a.count);
      lines.push(`  filename collisions: ${collisions.slice(0, 5).map((c) => `${c.name}(${c.count})`).join(" ")}`);
    }

    // Index Vectors with trap counts
    const trapped = this._indexVectors.filter((v) => v.trapCount > 0);
    if (trapped.length > 0) {
      lines.push(`  trap vectors: ${trapped.map((v) => `${v.path.split("/").pop()}(×${v.trapCount})`).join(" ")}`);
    }

    return lines.join("\n");
  }

  /** Reset (for testing). */
  clear(): void {
    this.root = createNode();
    this._totalHits = 0;
    this._previousTop = [];
    this._filenameIndex.clear();
    this._firstRecordTs = 0;
    this._lastActivityTs = 0;
    this._cumulativeActiveMs = 0;
    this._leafActiveTime.clear();
    this._indexVectors = [];
  }

  // ---- Internals ----

  private _updateFilenameIndex(basename: string, fullPath: string): void {
    let paths = this._filenameIndex.get(basename);
    if (!paths) {
      paths = new Set();
      this._filenameIndex.set(basename, paths);
    }
    paths.add(fullPath);
  }

  private _collectLeaves(
    node: HeatNode,
    segments: string[],
    out: Array<{ path: string; count: number }>,
    now: number,
  ): void {
    if (node.children.size === 0 && segments.length > 0) {
      out.push({ path: segments.join("/"), count: this.effectiveCount(node, now) });
      return;
    }
    for (const [seg, child] of node.children) {
      this._collectLeaves(child, [...segments, seg], out, now);
    }
  }

  private _collectLeavesWithNodes(
    node: HeatNode,
    segments: string[],
    out: Array<{ path: string; node: HeatNode }>,
  ): void {
    if (node.children.size === 0 && segments.length > 0) {
      out.push({ path: segments.join("/"), node });
      return;
    }
    for (const [seg, child] of node.children) {
      this._collectLeavesWithNodes(child, [...segments, seg], out);
    }
  }
}
