import type { UpperLayerConfig } from "./upper-layer/types.js";
import type { DigestorConfig } from "./digestor.js";
export interface GatewayConfig {
    server: {
        port: number;
    };
    upperLayer?: Partial<UpperLayerConfig>;
    digestor?: Partial<Omit<DigestorConfig, "qdrantUrl" | "collection">>;
}
export declare function loadConfig(): GatewayConfig;
