import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  chmodSync(dirPath, 0o700);
}

export function secureWriteFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}
