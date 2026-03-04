import type { StatusResponse } from "../types.js";
/**
 * GET /status
 */
export declare function handleStatus(projectId?: string): Promise<StatusResponse>;
