export interface DigestorConfig {
    intervalMs: number;
    promotionThreshold: number;
    ttlMs: number;
    qdrantUrl: string;
    collection: string;
}
export declare const DEFAULT_DIGESTOR_CONFIG: DigestorConfig;
export declare function addActiveProject(projectId: string): void;
export declare function removeActiveProject(projectId: string): Promise<void>;
export declare function getActiveProjects(): string[];
export declare function startDigestor(partial: Partial<DigestorConfig> & {
    qdrantUrl: string;
    collection: string;
}): void;
export declare function updateInterval(intervalMs: number): void;
export declare function getIntervalMs(): number;
export declare function updateTtl(ttlMs: number): void;
export declare function getTtlMs(): number;
export declare function stopDigestor(): void;
