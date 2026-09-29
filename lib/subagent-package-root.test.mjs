import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";

const {
  SUBAGENT_PACKAGE_ROOT_ENV,
  ensureSubagentPackageRoot,
  findPiCodingAgentPackageRoot,
} = await import("./subagent-package-root.ts");

const PKG = "@earendil-works/pi-coding-agent";
const PKG_JSON_SEGMENTS = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
];

/** Build a fake filesystem: map of package.json path -> package name. */
function fakeFs(files) {
  return {
    fileExists: (p) => files.has(p),
    readJson: (p) => {
      const name = files.get(p);
      if (name === undefined) throw new Error(`ENOENT: ${p}`);
      return { name };
    },
    realpath: (p) => p,
  };
}

function pkgJsonAt(rootDir) {
  return join(rootDir, ...PKG_JSON_SEGMENTS);
}

test("finds the package nested in the pi-web install tree", () => {
  const pkgRoot = join("srv", "pi-web");
  const entry = join(pkgRoot, "node_modules", "next", "dist", "bin", "next");
  const fs = fakeFs(new Map([[pkgJsonAt(pkgRoot), PKG]]));
  assert.equal(
    findPiCodingAgentPackageRoot(entry, fs),
    dirname(pkgJsonAt(pkgRoot)),
  );
});

test("finds a hoisted package in a shared ancestor node_modules", () => {
  // Global layout: <npm>/node_modules/@agegr/pi-web with the dependency
  // hoisted to <npm>/node_modules/@earendil-works/pi-coding-agent.
  const globalRoot = join("usr", "lib", "node_modules");
  const pkgRoot = join(globalRoot, "@agegr", "pi-web");
  const entry = join(pkgRoot, "bin", "pi-web.js");
  const fs = fakeFs(new Map([[join(globalRoot, ...PKG_JSON_SEGMENTS.slice(1)), PKG]]));
  assert.equal(
    findPiCodingAgentPackageRoot(entry, fs),
    dirname(join(globalRoot, ...PKG_JSON_SEGMENTS.slice(1))),
  );
});

test("ignores package.json files whose name does not match", () => {
  const pkgRoot = join("srv", "pi-web");
  const entry = join(pkgRoot, "bin", "pi-web.js");
  const fs = fakeFs(new Map([[pkgJsonAt(pkgRoot), "@agegr/pi-web"]]));
  assert.equal(findPiCodingAgentPackageRoot(entry, fs), null);
});

test("returns null when no install exists and tolerates unreadable entries", () => {
  const entry = join("srv", "pi-web", "bin", "pi-web.js");
  const fs = {
    fileExists: () => true,
    readJson: () => {
      throw new Error("EACCES");
    },
    realpath: (p) => p,
  };
  assert.equal(findPiCodingAgentPackageRoot(entry, fs), null);
});

test("ensureSubagentPackageRoot respects an existing override", () => {
  const env = { [SUBAGENT_PACKAGE_ROOT_ENV]: "  /custom/root  " };
  const result = ensureSubagentPackageRoot(env, join("no", "such", "entry.js"));
  assert.equal(result, null);
  assert.equal(env[SUBAGENT_PACKAGE_ROOT_ENV], "  /custom/root  ");
});

test("ensureSubagentPackageRoot seeds the variable when unset", () => {
  const pkgRoot = join("srv", "pi-web");
  const entry = join(pkgRoot, "node_modules", "next", "dist", "bin", "next");
  const expected = dirname(pkgJsonAt(pkgRoot));
  const env = {};
  const result = ensureSubagentPackageRoot(
    env,
    entry,
    fakeFs(new Map([[pkgJsonAt(pkgRoot), PKG]])),
  );
  assert.equal(result, expected);
  assert.equal(env[SUBAGENT_PACKAGE_ROOT_ENV], expected);
});

test("ensureSubagentPackageRoot leaves the variable unset when nothing is found", () => {
  const env = {};
  const result = ensureSubagentPackageRoot(
    env,
    join("srv", "pi-web", "bin", "pi-web.js"),
    fakeFs(new Map()),
  );
  assert.equal(result, null);
  assert.equal(SUBAGENT_PACKAGE_ROOT_ENV in env, false);
});
