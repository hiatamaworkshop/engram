/** Record pushed seeds with quality flags. */
export declare function memoAdd(seeds: Array<{
    summary: string;
    tags?: string[];
}>): void;
/** Format memo for response append. Empty string if nothing cached. */
export declare function memoFormat(): string;
