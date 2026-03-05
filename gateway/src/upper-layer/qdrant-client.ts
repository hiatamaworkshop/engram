// ============================================================
// UpperLayer — Qdrant REST client (native fetch, no SDK)
// ============================================================

import type { UpperLayerPointPayload } from "./types.js";

// ---- Collection management ----

export async function ensureCollection(
  url: string,
  name: string,
  dimension: number,
): Promise<void> {
  // Check if collection already exists
  const check = await fetch(`${url}/collections/${name}`);
  if (!check.ok) {
    // Create collection
    const res = await fetch(`${url}/collections/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: dimension, distance: "Cosine" },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant ensureCollection failed (${res.status}): ${body}`);
    }
  }

  // Ensure payload indexes exist (idempotent — safe to call on existing collections)
  await createIndex(url, name, "projectId", "keyword");
  await createIndex(url, name, "status", "keyword");
  await createIndex(url, name, "ingestedAt", "integer");
  await createIndex(url, name, "lastAccessedAt", "integer");
  await createIndex(url, name, "tags", "keyword");
  await createIndex(url, name, "weight", "float");
}

async function createIndex(
  url: string,
  collection: string,
  field: string,
  schema: "keyword" | "integer" | "float" | "text",
): Promise<void> {
  const res = await fetch(
    `${url}/collections/${collection}/index`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field_name: field,
        field_schema: schema,
      }),
    },
  );
  // Index creation may return 200 or 400 (already exists) — both are fine
  if (!res.ok && res.status !== 400) {
    console.warn(`[qdrant] index creation warning for ${field}: ${res.status}`);
  }
}

// ---- Point operations ----

export async function upsertPoints(
  url: string,
  collection: string,
  points: Array<{ id: string; vector: number[]; payload: UpperLayerPointPayload }>,
): Promise<void> {
  if (points.length === 0) return;

  const res = await fetch(`${url}/collections/${collection}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant upsert failed (${res.status}): ${body}`);
  }
}

export async function searchPoints(
  url: string,
  collection: string,
  vector: number[],
  filter?: Record<string, unknown>,
  limit = 10,
): Promise<Array<{ id: string; score: number; payload: UpperLayerPointPayload }>> {
  const body: Record<string, unknown> = {
    vector,
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;

  const res = await fetch(`${url}/collections/${collection}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant search failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    result: Array<{ id: string; score: number; payload: UpperLayerPointPayload }>;
  };
  return data.result;
}

export async function scrollPoints(
  url: string,
  collection: string,
  filter: Record<string, unknown>,
  limit: number,
  orderBy?: { key: string; direction: "asc" | "desc" },
): Promise<Array<{ id: string; payload: UpperLayerPointPayload }>> {
  const body: Record<string, unknown> = {
    filter,
    limit,
    with_payload: true,
  };
  if (orderBy) body.order_by = orderBy;

  const res = await fetch(`${url}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant scroll failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    result: { points: Array<{ id: string; payload: UpperLayerPointPayload }> };
  };
  return data.result.points;
}

export async function deletePoints(
  url: string,
  collection: string,
  pointIds: string[],
): Promise<void> {
  if (pointIds.length === 0) return;

  const res = await fetch(`${url}/collections/${collection}/points/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: pointIds }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant delete failed (${res.status}): ${text}`);
  }
}

export async function countPoints(
  url: string,
  collection: string,
  filter?: Record<string, unknown>,
): Promise<number> {
  const body: Record<string, unknown> = { exact: true };
  if (filter) body.filter = filter;

  const res = await fetch(`${url}/collections/${collection}/points/count`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant count failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { result: { count: number } };
  return data.result.count;
}

// ---- Payload update (partial — for access tracking) ----

export async function setPayload(
  url: string,
  collection: string,
  pointIds: string[],
  payload: Partial<UpperLayerPointPayload>,
): Promise<void> {
  if (pointIds.length === 0) return;

  const res = await fetch(`${url}/collections/${collection}/points/payload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload,
      points: pointIds,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant setPayload failed (${res.status}): ${text}`);
  }
}

// ---- Single point fetch ----

export async function getPointById(
  url: string,
  collection: string,
  pointId: string,
): Promise<{ id: string; payload: UpperLayerPointPayload } | null> {
  const res = await fetch(`${url}/collections/${collection}/points/${pointId}`);

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant getPoint failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    result: { id: string; payload: UpperLayerPointPayload };
  };
  return data.result;
}

// ---- Health ----

export async function checkQdrantHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
