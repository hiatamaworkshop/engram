// ============================================================
// UpperLayer — Embedding service
// ============================================================
//
// Lazy singleton pattern (sphere-original LocalEmbeddingProvider 準拠).
// Model: Xenova/all-MiniLM-L6-v2 (384 dims, ~50MB, ONNX quantized).
// First call triggers download + pipeline init. Subsequent calls are instant.

let pipeline: any = null;
let loadPromise: Promise<void> | null = null;
let modelId = "Xenova/all-MiniLM-L6-v2";
let dimension = 384;

export function configureEmbedding(model: string, dim: number): void {
  modelId = model;
  dimension = dim;
}

async function ensureLoaded(): Promise<void> {
  if (pipeline) return;
  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
    console.log(`[upper-layer] Loading embedding model: ${modelId}...`);
    const startTime = Date.now();

    const { pipeline: p } = await import("@xenova/transformers");
    pipeline = await p("feature-extraction", modelId, { quantized: true });

    console.log(`[upper-layer] Embedding model loaded in ${Date.now() - startTime}ms`);
  })();

  await loadPromise;
}

/**
 * Embed a single text → 384-dim vector.
 */
export async function embedText(text: string): Promise<number[]> {
  await ensureLoaded();

  const output = await pipeline(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Batch embed multiple texts → array of 384-dim vectors.
 * True batch processing (~5x faster than sequential).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  await ensureLoaded();

  const output = await pipeline(texts, { pooling: "mean", normalize: true });

  // output.data is a flat Float32Array: [vec1..., vec2..., vec3..., ...]
  const results: number[][] = [];
  const data = output.data as Float32Array;

  for (let i = 0; i < texts.length; i++) {
    const start = i * dimension;
    const end = start + dimension;
    results.push(Array.from(data.slice(start, end)));
  }

  return results;
}

export function isReady(): boolean {
  return pipeline !== null;
}
