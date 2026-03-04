import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "gateway.config.json");
let _config = null;
export function loadConfig() {
    if (_config)
        return _config;
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const file = JSON.parse(raw);
    // Qdrant URL — env override for Docker
    if (process.env.QDRANT_URL) {
        if (!file.upperLayer)
            file.upperLayer = {};
        file.upperLayer.qdrantUrl = process.env.QDRANT_URL;
    }
    _config = file;
    return _config;
}
//# sourceMappingURL=config.js.map