import type { IngestRequest } from "../types.js";
export interface GateError {
    code: string;
    message: string;
}
export interface GateResult {
    valid: boolean;
    errors: GateError[];
}
/**
 * Validate an ingest request.
 */
export declare function validateIngest(body: IngestRequest): GateResult;
