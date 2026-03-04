import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpperLayerConfig } from "./upper-layer/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "gateway.config.json");

export interface GatewayConfig {
  server: { port: number };
  upperLayer?: Partial<UpperLayerConfig>;
}

let _config: GatewayConfig | null = null;

export function loadConfig(): GatewayConfig {
  if (_config) return _config;
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const file = JSON.parse(raw) as GatewayConfig;

  // Qdrant URL — env override for Docker
  if (process.env.QDRANT_URL) {
    if (!file.upperLayer) file.upperLayer = {};
    file.upperLayer.qdrantUrl = process.env.QDRANT_URL;
  }

  _config = file;
  return _config;
}
