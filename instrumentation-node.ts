import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import {
  ensureSubagentPackageRoot,
  SUBAGENT_PACKAGE_ROOT_ENV,
} from "@/lib/subagent-package-root";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // pi-subagents cannot discover the bundled pi-coding-agent from inside
  // pi-web (argv walk finds @agegr/pi-web; sandbox import.meta.resolve
  // fails), so seed its documented escape-hatch variable from our own
  // dependency tree. An explicit operator setting always wins.
  const subagentRoot = ensureSubagentPackageRoot();
  if (subagentRoot) {
    console.info(
      `pi-web: ${SUBAGENT_PACKAGE_ROOT_ENV}=${subagentRoot} (auto-detected)`,
    );
  }

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
