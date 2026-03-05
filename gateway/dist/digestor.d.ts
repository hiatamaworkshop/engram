export interface DigestorConfig {
    intervalMs: number;
    promotionThreshold: number;
    promotionHitCount: number;
    decayPerBatch: number;
    ttlSeconds: number;
    idleThresholdMs: number;
    qdrantUrl: string;
    collection: string;
}
export declare const DEFAULT_DIGESTOR_CONFIG: DigestorConfig;
export declare function addActiveProject(projectId: string): void;
export declare function removeActiveProject(projectId: string): Promise<void>;
export declare function getActiveProjects(): string[];
/** Update last-activity timestamp. Auto-activates if project was not in the set. */
export declare function touchProject(projectId: string): void;
export declare function startDigestor(partial: Partial<DigestorConfig> & {
    qdrantUrl: string;
    collection: string;
}): void;
export declare function updateTtl(ttlSeconds: number): void;
export declare function getTtlSeconds(): number;
export declare function stopDigestor(): void;
/** Queue a hit/weight bump — throttled: weight only bumped once per batch window per node. */
export declare function queueBump(pointId: string, hitDelta: number, weightDelta: number): void;
/** Get cached counts. Returns null if cache is stale or missing. */
export declare function getCachedCounts(projectId?: string): {
    total: number;
    recent: number;
    fixed: number;
} | null;
/** Get cached project listing. Returns null if stale or missing. */
export declare function getCachedProjectList(): Array<{
    projectId: string;
    count: number;
}> | null;
