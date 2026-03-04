import type { NodeSeed, RecallResult, ScanEntry, NodeStatus, FeedbackSignal, FeedbackResponse } from "../types.js";
import type { UpperLayerConfig, SearchOptions } from "./types.js";
export declare function initUpperLayer(partial?: Partial<UpperLayerConfig>): Promise<void>;
export declare function ingestNodes(nodes: NodeSeed[], projectId: string, trigger?: string, sessionId?: string): Promise<{
    ingested: number;
}>;
export declare function searchNodes(options: SearchOptions): Promise<RecallResult[]>;
export interface ListFilters {
    tag?: string;
    status?: NodeStatus;
    sort?: "recent" | "weight";
}
export declare function listNodes(projectId: string, limit: number, filters?: ListFilters): Promise<ScanEntry[]>;
export declare function getNodeById(entryId: string): Promise<RecallResult | null>;
export declare function applyFeedback(entryId: string, signal: FeedbackSignal, _reason?: string): Promise<FeedbackResponse>;
export declare function checkUpperLayerHealth(): Promise<boolean>;
export declare function getUpperLayerStats(): {
    initialized: boolean;
    embeddingReady: boolean;
    collection: string;
};
export declare function listProjects(): Promise<Array<{
    projectId: string;
    count: number;
}>>;
export declare function getNodeCounts(projectId?: string): Promise<{
    total: number;
    recent: number;
    fixed: number;
}>;
