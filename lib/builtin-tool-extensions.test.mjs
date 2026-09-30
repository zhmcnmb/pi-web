import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createBuiltinToolExtensions } = await jiti.import("./builtin-tool-extensions.ts");
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { projectTrustReloadOptions, trustProject } = await jiti.import("./project-trust.ts");

async function fixture(t, settings = {}) {
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), "pi-web-builtin-tools-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const wrappers = [];
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings), "utf8");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    for (const wrapper of wrappers) await wrapper.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, agentDir, wrappers };
}

async function sdkSession(f, extensionFactories = createBuiltinToolExtensions(), tools) {
  const services = await createAgentSessionServices({
    cwd: f.cwd,
    agentDir: f.agentDir,
    resourceLoaderOptions: { extensionFactories, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
    resourceLoaderReloadOptions: projectTrustReloadOptions(f.cwd, f.agentDir),
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(f.cwd),
    ...(tools ? { tools } : {}),
  });
  const wrapper = new AgentSessionWrapper(session);
  f.wrappers.push(wrapper);
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  return { session, wrapper, services };
}

async function waitForTools(session, names) {
  for (let i = 0; i < 200; i++) {
    const registered = new Set(session.getAllTools().map((tool) => tool.name));
    if (names.every((name) => registered.has(name))) return;
    await delay(10);
  }
  assert.fail(`MCP tools did not register: ${names.join(", ")}`);
}

async function mockMcpServer(t) {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push(message);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local-test", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "Echo test text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: message.params.arguments.text }] };
    } else {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls };
}

test("official tools register inactive, follow modifiers, and survive preset changes and reload", async (t) => {
  const f = await fixture(t, { defaultTools: ["read"] });
  const { session, services } = await sdkSession(f);
  assert.deepEqual(services.resourceLoader.getExtensions().extensions.map((e) => e.path).sort(), ["builtin:codemode", "builtin:mcp", "builtin:tool-search"]);
  assert.ok(session.getAllTools().some((tool) => tool.name === "codemode"));
  assert.ok(session.getAllTools().some((tool) => tool.name === "tool_search"));
  assert.deepEqual(session.getActiveToolNames(), ["read"]);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "+codemode", "+tool_search"] }), "utf8");
  const enabled = await sdkSession(f);
  assert.ok(enabled.session.getActiveToolNames().includes("codemode"));
  assert.ok(enabled.session.getActiveToolNames().includes("tool_search"));
  enabled.wrapper.setActiveToolSelection(["read", "grep"]);
  await enabled.wrapper.send({ type: "reload" });
  assert.deepEqual(enabled.session.getActiveToolNames().sort(), ["read", "grep", "codemode", "tool_search"].sort());
});

test("disable settings and user replacements retain CLI precedence", async (t) => {
  const f = await fixture(t, { extensions: ["-builtin:mcp", "-builtin:tool-search"] });
  const replacement = (pi) => pi.registerTool({
    name: "codemode", label: "replacement", description: "user replacement",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }),
  });
  const { services, session } = await sdkSession(f, [...createBuiltinToolExtensions(), replacement]);
  assert.equal(services.resourceLoader.getExtensions().errors.length, 0);
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
  assert.equal(session.getAllTools().find((tool) => tool.name === "codemode").description, "user replacement");
  assert.ok(!session.getAllTools().some((tool) => tool.name === "tool_search"));
  assert.ok(!services.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("mcp")));
});

test("MCP exposure, discovery, scripts and nested permissions use the real SDK pipeline", async (t) => {
  const f = await fixture(t, { defaultTools: ["read"] });
  const { url, calls } = await mockMcpServer(t);
  const mcpServers = Object.fromEntries(["direct", "codemode", "deferred", "hidden"].map((exposure) => [exposure, { url, exposure }]));
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers }), "utf8");
  const blocked = [];
  const driver = (pi) => {
    pi.registerTool({
      name: "test_driver", label: "driver", description: "test driver", parameters: { type: "object", properties: {} },
      execute: async (_id, { name, args }, _signal, _update, ctx) => {
        const outcome = await ctx.executeTool(name, args);
        return { ...outcome.result, isError: outcome.isError };
      },
    });
    pi.on("tool_call", (event) => {
      if (event.toolName === "mcp__direct__echo" && event.input.text === "blocked") {
        blocked.push(event.parentToolCallId);
        return { block: true, reason: "denied by test permission" };
      }
    });
  };
  const { session, wrapper } = await sdkSession(f, [...createBuiltinToolExtensions(), driver]);
  await waitForTools(session, ["mcp__direct__echo", "mcp__codemode__echo", "mcp__deferred__echo", "mcp__hidden__echo"]);
  const active = session.getActiveToolNames();
  assert.ok(active.includes("mcp__direct__echo"));
  assert.ok(active.includes("codemode") && active.includes("tool_search"));
  assert.ok(!active.includes("mcp__codemode__echo") && !active.includes("mcp__deferred__echo") && !active.includes("mcp__hidden__echo"));
  assert.ok(!session.getCallableToolNames().includes("mcp__hidden__echo"));
  // Seed the SDK's caller context without making a provider request.
  session.sessionManager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
  session.refreshContext();
  const tool = (name) => session.agent.state.tools.find((item) => item.name === name);
  const echo = await tool("test_driver").execute("driver-direct", { name: "mcp__direct__echo", args: { text: "direct works" } });
  assert.equal(echo.content[0].text, "direct works");
  const denied = await tool("test_driver").execute("driver-denied", { name: "mcp__direct__echo", args: { text: "blocked" } });
  assert.equal(denied.isError, true);
  assert.deepEqual(blocked, ["driver-denied"]);
  assert.ok(!calls.some((message) => message.method === "tools/call" && message.params.arguments.text === "blocked"));
  const scripted = await tool("codemode").execute("script-parent", { code: 'return await tools.mcp__codemode__echo({text: "script works"});' });
  assert.ok(!scripted.isError, JSON.stringify(scripted.content));
  assert.match(JSON.stringify(scripted.content), /script works/);
  await tool("tool_search").execute("search-parent", { query: "mcp__deferred__echo", limit: 1 });
  assert.ok(session.getActiveToolNames().includes("mcp__deferred__echo"));
  await wrapper.send({ type: "reload" });
  await waitForTools(session, ["mcp__direct__echo"]);
  assert.ok(session.getActiveToolNames().includes("mcp__direct__echo"));
});

test("real RPC entry gates project MCP and keeps Chat-only disconnected", async (t) => {
  const f = await fixture(t, { defaultTools: ["read"] });
  const { url, calls } = await mockMcpServer(t);
  await mkdir(join(f.cwd, ".pi"));
  await writeFile(join(f.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project: { url, exposure: "direct" } } }), "utf8");
  assert.ok(projectTrustReloadOptions(f.cwd, f.agentDir));
  const untrusted = (await startRpcSession("untrusted-test", undefined, f.cwd, { toolNames: ["read"] })).session;
  f.wrappers.push(untrusted);
  await untrusted.waitUntilReady();
  assert.equal(calls.length, 0);
  assert.ok(!untrusted.inner.getAllTools().some((tool) => tool.name.startsWith("mcp__")));
  trustProject(f.cwd, f.agentDir);
  const trusted = (await startRpcSession("trusted-test", undefined, f.cwd, { toolNames: ["read"] })).session;
  f.wrappers.push(trusted);
  await trusted.waitUntilReady();
  await waitForTools(trusted.inner, ["mcp__project__echo"]);
  const count = calls.length;
  const chatOnly = (await startRpcSession("chat-only-test", undefined, f.cwd, { toolNames: [] })).session;
  f.wrappers.push(chatOnly);
  assert.deepEqual(chatOnly.inner.getAllTools(), []);
  assert.equal(calls.length, count);
  const restricted = await sdkSession(f, createBuiltinToolExtensions(), ["read"]);
  assert.deepEqual(restricted.session.getActiveToolNames(), ["read"]);
  assert.ok(!restricted.session.getAllTools().some((tool) => tool.name === "codemode" || tool.name.startsWith("mcp__")));
});
