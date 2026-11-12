import * as path from "path";

/** Paths compare case-insensitively on Windows and macOS (default file systems). */
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

/** Resolved, without trailing separator, lowercased where the file system is case-insensitive. */
export function pathKey(p: string, pathModule: path.PlatformPath = path, insensitive = caseInsensitive): string {
  let resolved = pathModule.resolve(p);
  const root = pathModule.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return insensitive ? resolved.toLowerCase() : resolved;
}

/** Whether `child` is `parent` or inside it. */
export function isInside(
  child: string,
  parent: string,
  pathModule: path.PlatformPath = path,
  insensitive = caseInsensitive,
): boolean {
  const c = pathKey(child, pathModule, insensitive);
  const p = pathKey(parent, pathModule, insensitive);
  if (c === p) {
    return true;
  }
  const prefix = p.endsWith(pathModule.sep) ? p : p + pathModule.sep;
  return c.startsWith(prefix);
}

/** Root and last folder only, for example `C:\…\my-worktree`, to keep long paths readable. */
export function shortPath(p: string, pathModule: path.PlatformPath = path): string {
  const normalized = pathModule.normalize(p).replace(/[\\/]+$/, "");
  const root = pathModule.parse(normalized).root;
  const name = pathModule.basename(normalized);
  if (!name || pathModule.dirname(normalized) === root || normalized === root) {
    return normalized;
  }
  return `${root}…${pathModule.sep}${name}`;
}

/** Converts a path printed by git (forward slashes on Windows) to a native path. */
export function nativePath(p: string): string {
  return path.normalize(p);
}
