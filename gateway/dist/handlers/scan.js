import { listNodes } from "../upper-layer/index.js";
/**
 * GET /scan/:projectId?limit=10&tag=docker&status=fixed
 */
export async function handleScan(projectId, limit = 10, tag, status) {
    try {
        const filters = (tag || status) ? { tag, status } : undefined;
        const entries = await listNodes(projectId, limit, filters);
        return { entries, total: entries.length };
    }
    catch {
        return { entries: [], total: 0 };
    }
}
//# sourceMappingURL=scan.js.map