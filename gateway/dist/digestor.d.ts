export interface DigestorConfig {
    intervalMs: number;
    promotionThreshold: number;
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
