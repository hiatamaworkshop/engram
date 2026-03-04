import type { NodeStatus } from "../types.js";
export interface UpperLayerConfig {
    qdrantUrl: string;
    collection: string;
    embeddingModel: string;
    embeddingDimension: number;
    maxDistance: number;
}
export declare const DEFAULT_UPPER_LAYER_CONFIG: UpperLayerConfig;
export interface UpperLayerPointPayload {
    summary: string;
    tags: string[];
    content: string;
    projectId: string;
    source: string;
    trigger: string;
    sessionId: string;
    status: NodeStatus;
    hitCount: number;
    weight: number;
    ttl?: number;
}
export interface SearchOptions {
    query: string;
    projectId?: string;
    limit?: number;
    minWeight?: number;
    status?: "recent" | "fixed";
}
