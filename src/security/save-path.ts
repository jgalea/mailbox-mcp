import { resolve, dirname, join, basename, sep } from "node:path";
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";

export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads", "mailbox-mcp");

export const ALLOWED_BASE_DIRS = [
  DEFAULT_DOWNLOAD_DIR,
  "/tmp",
];

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * Resolve a path's canonical form, walking up to the deepest existing
 * ancestor so symlinks like macOS's `/tmp -> /private/tmp` are followed even
 * when the target path itself has not been created yet. The native realpath
 * also returns the on-disk spelling, where the JavaScript one keeps whatever
 * case the caller typed.
 */
export function canonicalize(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
  const realBase = realpathSync.native(probe);
  return probe === absolute ? realBase : join(realBase, absolute.slice(probe.length));
}

// Whether `target` is `base` or sits below it. Both are canonicalized; on
// case-insensitive filesystems the strings are compared case-folded as well,
// and when the base exists its device and inode are checked against every
// existing ancestor of the target, which holds regardless of how a particular
// volume treats case.
export function pathIsInside(target: string, base: string): boolean {
  const t = canonicalize(target);
  const b = canonicalize(base);
  const fold = (s: string) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);
  if (fold(t) === fold(b) || fold(t).startsWith(fold(b) + sep)) return true;
  let baseStat;
  try {
    baseStat = statSync(b);
  } catch {
    return false;
  }
  let probe = t;
  while (true) {
    try {
      const s = statSync(probe);
      if (s.dev === baseStat.dev && s.ino === baseStat.ino) return true;
    } catch {
      // Not created yet; keep walking up.
    }
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}

// The config and log directories hold credentials, the approval queue and the
// send log. Nothing the model can call may write there, whatever the save
// allowlist says: a downloaded attachment named accounts.json or sends.jsonl
// would otherwise rewrite the guards.
export function protectedDirs(): string[] {
  const home = join(homedir(), ".mailbox-mcp");
  return [process.env.MAILBOX_MCP_CONFIG_DIR || home, process.env.MAILBOX_MCP_LOG_DIR || home];
}

export function isInsideProtectedDir(path: string): boolean {
  return protectedDirs().some((base) => pathIsInside(path, base));
}

/** Checks a save directory and returns its canonical form, which is the only form callers may write to. */
export function validateSavePath(dir: string): string {
  const resolved = canonicalize(dir);
  if (isInsideProtectedDir(resolved)) {
    throw new Error(`Save directory "${dir}" is inside the mailbox-mcp config or log directory, which holds credentials and safety state. Refusing to write there.`);
  }
  if (!ALLOWED_BASE_DIRS.some((base) => pathIsInside(resolved, base))) {
    throw new Error(
      `Save directory "${dir}" is not allowed. ` +
      `Permitted locations: ${ALLOWED_BASE_DIRS.join(", ")}`
    );
  }
  return resolved;
}

// The one way tool output reaches disk. The directory is validated, created,
// then validated again in its now-existing canonical form, so a component
// that turned into a symlink in between cannot move the write; the file is
// opened with O_NOFOLLOW so a symlink planted under the final name is refused
// rather than followed.
export function saveFile(dir: string, filename: string, data: Buffer, afterMkdir?: () => void): string {
  const name = basename(filename);
  if (!name || name === "." || name === "..") throw new Error(`Refusing to save a file named "${filename}"`);
  mkdirSync(validateSavePath(dir), { recursive: true });
  afterMkdir?.();
  const finalDir = validateSavePath(dir);
  const filePath = join(finalDir, name);
  if (isInsideProtectedDir(filePath)) {
    throw new Error(`Refusing to write ${filePath}: inside the mailbox-mcp config or log directory.`);
  }
  try {
    if (lstatSync(filePath).isSymbolicLink()) throw new Error(`Refusing to write through the symlink at ${filePath}.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, data);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return filePath;
}
