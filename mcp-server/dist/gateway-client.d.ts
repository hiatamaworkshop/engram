import type { EngramContext, NodeSeed, NodeStatus, IngestTrigger, FeedbackSignal } from "./types.js";
export interface RecallResult {
    id: string;
    relevance: number;
    summary: string;
    tags: string[];
    hitCount: number;
    weight: number;
    status: NodeStatus;
    timestamp: number;
    content?: string;
}
export interface RecallResponse {
    results: RecallResult[];
    source: string;
    message?: string;
}
export interface IngestResponse {
    status: "accepted" | "rejected";
    reason?: string;
    projectId?: string;
    nodesIngested?: number;
    merged?: number;
}
export interface StatusResponse {
    store: {
        initialized: boolean;
        embeddingReady: boolean;
        collection: string;
    } | null;
    totalNodes: number | null;
    recentNodes: number | null;
    fixedNodes: number | null;
}
export interface ScanEntry {
    id: string;
    summary: string;
    tags: string[];
    hitCount: number;
    weight: number;
    status: NodeStatus;
}
export interface FeedbackResponse {
    status: "applied" | "not-found" | "error";
    entryId: string;
    signal: string;
    newWeight?: number;
}
export interface ScanResponse {
    entries: ScanEntry[];
    total: number;
}
export declare function checkHealth(ctx: EngramContext): Promise<boolean>;
export declare function recallNodes(ctx: EngramContext, query: string, projectId?: string, limit?: number): Promise<RecallResponse>;
export declare function recallById(ctx: EngramContext, entryId: string): Promise<RecallResponse>;
export declare function scan(ctx: EngramContext, projectId: string, limit?: number, tag?: string, status?: string): Promise<ScanResponse>;
export declare function ingest(ctx: EngramContext, capsuleSeeds: NodeSeed[], projectId: string, trigger: IngestTrigger, sessionId?: string): Promise<IngestResponse>;
export declare function feedback(ctx: EngramContext, entryId: string, signal: FeedbackSignal, reason?: string): Promise<FeedbackResponse>;
export declare function activateProject(ctx: EngramContext, projectId: string, intervalMs?: number, ttlMs?: number): Promise<void>;
export declare function deactivateProject(ctx: EngramContext, projectId: string): Promise<void>;
export declare function getStatus(ctx: EngramContext, projectId?: string): Promise<StatusResponse>;
