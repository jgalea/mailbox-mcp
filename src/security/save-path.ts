import { resolve, dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads", "mailbox-mcp");

export const ALLOWED_BASE_DIRS = [
  DEFAULT_DOWNLOAD_DIR,
  "/tmp",
];

/**
 * Resolve a path's canonical form, walking up to the deepest existing
 * ancestor so symlinks like macOS's `/tmp -> /private/tmp` are followed even
 * when the target path itself has not been created yet.
 */
export function canonicalize(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
  const realBase = realpathSync(probe);
  return probe === absolute ? realBase : join(realBase, absolute.slice(probe.length));
}

export function validateSavePath(dir: string): void {
  const resolved = canonicalize(dir);
  const isAllowed = ALLOWED_BASE_DIRS.some((base) => {
    const resolvedBase = canonicalize(base);
    return resolved === resolvedBase || resolved.startsWith(resolvedBase + "/");
  });
  if (!isAllowed) {
    throw new Error(
      `Save directory "${dir}" is not allowed. ` +
      `Permitted locations: ${ALLOWED_BASE_DIRS.join(", ")}`
    );
  }
}
