// ============================================================
// Receptor — Path Heatmap
// ============================================================
// Tracks file access counts as a weighted tree.
// Directory nodes = sum of children (structural property).
// Provides "where is the agent working" signal to emotion system.

import type { HeatNode, NormalizedEvent } from "./types.js";

export class PathHeatmap {
  private root: HeatNode = { count: 0, children: new Map() };
  private _totalHits = 0;
  private _previousTop: string[] = [];

  /** Record a file access. Only file_read, file_edit, search count. */
  record(event: NormalizedEvent): void {
    if (!event.path) return;
    if (event.action !== "file_read" && event.action !== "file_edit" && event.action !== "search") return;

    const segments = event.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length === 0) return;

    this._totalHits++;
    let node = this.root;
    node.count++;

    for (const seg of segments) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { count: 0, children: new Map() });
      }
      node = node.children.get(seg)!;
      node.count++;
    }
  }

  /** Get top N hottest leaf paths. */
  topPaths(n: number): Array<{ path: string; count: number }> {
    const leaves: Array<{ path: string; count: number }> = [];
    this._collectLeaves(this.root, [], leaves);
    leaves.sort((a, b) => b.count - a.count);
    return leaves.slice(0, n);
  }

  /** Detect if hot paths changed significantly since last check. */
  detectShift(topN = 5): { shifted: boolean; newPaths: string[] } {
    const current = this.topPaths(topN).map((p) => p.path);
    const currentSet = new Set(current);
    const newPaths = current.filter((p) => !this._previousTop.includes(p));
    const shifted = newPaths.length >= Math.ceil(topN / 2); // majority changed
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
    return node.count <= 1; // 1 = just recorded for first time
  }

  get totalHits(): number {
    return this._totalHits;
  }

  /** Reset (for testing). */
  clear(): void {
    this.root = { count: 0, children: new Map() };
    this._totalHits = 0;
    this._previousTop = [];
  }

  // ---- Internals ----

  private _collectLeaves(
    node: HeatNode,
    segments: string[],
    out: Array<{ path: string; count: number }>,
  ): void {
    if (node.children.size === 0 && segments.length > 0) {
      out.push({ path: segments.join("/"), count: node.count });
      return;
    }
    for (const [seg, child] of node.children) {
      this._collectLeaves(child, [...segments, seg], out);
    }
  }
}