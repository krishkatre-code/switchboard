import type { Config } from "../../config/env";
import type { Store } from "./Store";
import { FileStore } from "./FileStore";
import { QuickApiStore } from "./QuickApiStore";

export type { Store } from "./Store";

export function buildStore(cfg: Config["store"]): Store {
  if (cfg.backend === "quick") {
    return new QuickApiStore(cfg.quickApiBaseUrl);
  }
  return new FileStore(cfg.filePath);
}
