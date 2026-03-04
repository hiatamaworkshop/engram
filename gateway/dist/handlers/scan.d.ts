import type { ScanResponse, NodeStatus } from "../types.js";
type SortOption = "recent" | "weight";
/**
 * GET /scan/:projectId?limit=10&tag=docker&status=fixed&sort=recent
 */
export declare function handleScan(projectId: string, limit?: number, tag?: string, status?: NodeStatus, sort?: SortOption): Promise<ScanResponse>;
export {};
