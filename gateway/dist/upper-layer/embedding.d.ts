export declare function configureEmbedding(model: string, dim: number): void;
/**
 * Embed a single text → 384-dim vector.
 */
export declare function embedText(text: string): Promise<number[]>;
/**
 * Batch embed multiple texts → array of 384-dim vectors.
 * True batch processing (~5x faster than sequential).
 */
export declare function embedTexts(texts: string[]): Promise<number[][]>;
export declare function isReady(): boolean;
