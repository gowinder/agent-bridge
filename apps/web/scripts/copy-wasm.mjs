import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "..", "..", "..", "packages", "crypto", "wasm", "noise.wasm");
const targetDir = join(root, "..", "public");
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, join(targetDir, "noise.wasm"));
