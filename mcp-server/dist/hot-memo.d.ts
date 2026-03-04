type ToolContext = "push" | "pull" | "status" | "ls" | "flag";
/** Record pushed seeds with quality flags. */
export declare function memoAdd(seeds: Array<{
    summary: string;
    tags?: string[];
}>): void;
/** Build contextual memo. Returns empty string if nothing to say. */
export declare function memoFormat(context: ToolContext): string;
export {};
