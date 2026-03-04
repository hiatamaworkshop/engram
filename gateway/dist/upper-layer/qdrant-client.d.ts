import type { UpperLayerPointPayload } from "./types.js";
export declare function ensureCollection(url: string, name: string, dimension: number): Promise<void>;
export declare function upsertPoints(url: string, collection: string, points: Array<{
    id: string;
    vector: number[];
    payload: UpperLayerPointPayload;
}>): Promise<void>;
export declare function searchPoints(url: string, collection: string, vector: number[], filter?: Record<string, unknown>, limit?: number): Promise<Array<{
    id: string;
    score: number;
    payload: UpperLayerPointPayload;
}>>;
export declare function scrollPoints(url: string, collection: string, filter: Record<string, unknown>, limit: number, orderBy?: {
    key: string;
    direction: "asc" | "desc";
}): Promise<Array<{
    id: string;
    payload: UpperLayerPointPayload;
}>>;
export declare function deletePoints(url: string, collection: string, pointIds: string[]): Promise<void>;
export declare function countPoints(url: string, collection: string, filter?: Record<string, unknown>): Promise<number>;
export declare function setPayload(url: string, collection: string, pointIds: string[], payload: Partial<UpperLayerPointPayload>): Promise<void>;
export declare function getPointById(url: string, collection: string, pointId: string): Promise<{
    id: string;
    payload: UpperLayerPointPayload;
} | null>;
export declare function checkQdrantHealth(url: string): Promise<boolean>;
