// ============================================================
// Receptor — Path Heatmap (Multi-Index)
// ============================================================
// Tracks file access as a multi-dimensional weighted tree.
// Each leaf node carries 6 index axes for staleness detection.
// Directory nodes aggregate count only (structural property).

import type { HeatNode, NormalizedEvent, HeatmapSnapshot, AgentState } from "./types.js";
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

  set agentState(s: AgentState) { this._agentState = s; }
  get agentState(): AgentState { return this._agentState; }

  /** Register an async fs.stat provider for lastModified. */
  setStatProvider(fn: (path: string) => Promise<number>): void {
    this._statProvider = fn;
  }

  /** Record a file access. Only file_read, file_edit, search count. */
  record(event: NormalizedEvent): void {
    if (!event.path) return;
    if (event.action !== "file_read" && event.action !== "file_edit" && event.action !== "search") return;

    const segments = event.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length === 0) return;

    this._totalHits++;
    const now = event.ts || Date.now();
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

    // Update filenameIndex (basename → full paths)
    const fullPath = segments.join("/");
    const basename = segments[segments.length - 1];
    this._updateFilenameIndex(basename, fullPath);

    // Fire-and-forget lastModified via stat provider
    if (this._statProvider && (event.action === "file_read" || event.action === "file_edit")) {
      this._statProvider(event.path).then((mtime) => {
        if (mtime > 0) node.lastModified = mtime;
      }).catch(() => { /* stat failure is safe to ignore */ });
    }
  }

  // ---- Time decay ----

  /** Effective count with exponential time decay. */
  effectiveCount(node: HeatNode, now?: number): number {
    if (node.lastAccess === 0) return node.count;
    const dt = (now ?? Date.now()) - node.lastAccess;
    return node.count * Math.exp(-dt / cfg.halfLife);
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

  /** Reset (for testing). */
  clear(): void {
    this.root = createNode();
    this._totalHits = 0;
    this._previousTop = [];
    this._filenameIndex.clear();
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
}
