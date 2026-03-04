import type { ScanResponse, NodeStatus } from "../types.js";
/**
 * GET /scan/:projectId?limit=10&tag=docker&status=fixed
 */
export declare function handleScan(projectId: string, limit?: number, tag?: string, status?: NodeStatus): Promise<ScanResponse>;
