import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";

/**
 * Escape-hatch variable read by pi-subagents when it cannot discover the
 * host `@earendil-works/pi-coding-agent` package on its own. Under pi-web
 * both discovery paths fail: walking up from `argv[1]` finds `@agegr/pi-web`
 * (name mismatch), and `import.meta.resolve` cannot see pi-web's dependency
 * tree from inside the extension sandbox. pi-web bundles pi-coding-agent as
 * a direct dependency, so it seeds this variable at server startup instead
 * of requiring every operator to set it manually.
 */
export const SUBAGENT_PACKAGE_ROOT_ENV =
  "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PACKAGE_JSON_SEGMENTS = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
] as const;

export interface FindPiCodingAgentPackageRootOptions {
  /** Probe used to test a candidate path, injectable for tests. */
  fileExists?: (path: string) => boolean;
  /** package.json reader, injectable for tests. Return parsed JSON. */
  readJson?: (path: string) => { name?: unknown };
  /** Symlink resolver, injectable for tests. */
  realpath?: (path: string) => string;
}

function defaultReadJson(path: string): { name?: unknown } {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Walk up from a script entry point looking for an installed
 * `@earendil-works/pi-coding-agent` package. Covers both a nested
 * `<pi-web>/node_modules/...` install and a hoisted layout where the
 * package sits in a shared ancestor `node_modules`.
 */
export function findPiCodingAgentPackageRoot(
  entryPoint: string,
  options: FindPiCodingAgentPackageRootOptions = {},
): string | null {
  const fileExists = options.fileExists ?? existsSync;
  const readJson = options.readJson ?? defaultReadJson;
  const realpath = options.realpath ?? realpathSync;
  let start = entryPoint;
  try {
    start = realpath(entryPoint);
  } catch {
    // Keep the unresolved entry point; the walk is best-effort.
  }
  let dir = dirname(start);
  while (dir !== dirname(dir)) {
    const packageJsonPath = join(dir, ...PACKAGE_JSON_SEGMENTS);
    try {
      if (
        fileExists(packageJsonPath) &&
        readJson(packageJsonPath).name === PI_CODING_AGENT_PACKAGE
      ) {
        return dirname(packageJsonPath);
      }
    } catch {
      // Unreadable candidate; keep walking.
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Set `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` to the bundled
 * pi-coding-agent package root, unless the operator already set it.
 * Returns the root that was set, or null when nothing changed (explicit
 * override present, or no install found).
 */
export function ensureSubagentPackageRoot(
  env: NodeJS.ProcessEnv = process.env,
  entryPoint: string | undefined = process.argv[1],
  options: FindPiCodingAgentPackageRootOptions = {},
): string | null {
  if (env[SUBAGENT_PACKAGE_ROOT_ENV]?.trim()) return null;
  const root = entryPoint
    ? findPiCodingAgentPackageRoot(entryPoint, options)
    : null;
  if (root) env[SUBAGENT_PACKAGE_ROOT_ENV] = root;
  return root;
}
