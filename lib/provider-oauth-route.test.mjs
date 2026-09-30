import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { GET } = await createJiti(import.meta.url, { tsconfigPaths: true })
  .import("../app/api/auth/login/[provider]/route.ts");

async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-oauth-device-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(agentDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  return join(agentDir, "settings.json");
}

async function login(provider = "openai") {
  const response = await GET(new Request("http://localhost/api/auth/login/" + provider), {
    params: Promise.resolve({ provider }),
  });
  return response.text();
}

test("OAuth receives a stable device ID persisted in global settings", async (t) => {
  const settingsPath = await fixture(t);
  await writeFile(settingsPath, JSON.stringify({ unrelated: "keep" }));
  const ids = [];
  t.mock.method(ModelRuntime.prototype, "login", async (_provider, _type, _interaction, options) => {
    const id = options.getDeviceId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    ids.push(id);
  });
  assert.match(await login(), /"type":"success"/);
  assert.match(await login(), /"type":"success"/);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    unrelated: "keep", deviceId: ids[0],
  });
});

test("OAuth providers that do not request a device ID leave settings untouched", async (t) => {
  const settingsPath = await fixture(t);
  t.mock.method(ModelRuntime.prototype, "login", async () => {});
  assert.match(await login("anthropic"), /"type":"success"/);
  assert.equal(existsSync(settingsPath), false);
});

test("device ID creation refuses to overwrite malformed global settings", async (t) => {
  const settingsPath = await fixture(t);
  const original = "{ malformed";
  await writeFile(settingsPath, original);
  t.mock.method(ModelRuntime.prototype, "login", async (_provider, _type, _interaction, options) => {
    options.getDeviceId();
  });
  assert.match(await login(), /"type":"error"/);
  assert.equal(await readFile(settingsPath, "utf8"), original);
});
