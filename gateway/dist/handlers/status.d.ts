import type { StatusResponse } from "../types.js";
/**
 * GET /status
 * When projectId is omitted, includes a project listing.
 */
export declare function handleStatus(projectId?: string): Promise<StatusResponse>;
