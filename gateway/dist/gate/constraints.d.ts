export declare const SEED_CONSTRAINTS: {
    readonly minSummaryLength: 10;
    readonly maxSummaryLength: 200;
    readonly maxContentLength: 2000;
    readonly minTags: 1;
    readonly maxTags: 5;
};
/** Low quality summary patterns — reject these */
export declare const LOW_QUALITY_PATTERNS: readonly RegExp[];
