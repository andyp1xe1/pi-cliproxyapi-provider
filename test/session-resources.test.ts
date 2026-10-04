import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import * as codexStream from "../extensions/codex-stream.ts";
import providerExtension, { resetCompatCoordinator } from "../extensions/index.ts";

it("bridges companion cleanup into the host session registry and unregisters at shutdown", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "cpa-session-resources-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("CLIPROXYAPI_API_KEY", "");
	const streams = await codexStream.loadCliproxyCodexStreams();
	const close = vi.fn(streams.closeOpenAICodexWebSocketSessions);
	const loadSpy = vi.spyOn(codexStream, "loadCliproxyCodexStreams").mockResolvedValue({
		...streams,
		closeOpenAICodexWebSocketSessions: close,
	});
	const shutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
	const pi = {
		registerCommand: vi.fn(),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		}),
	} as unknown as ExtensionAPI;
	try {
		await providerExtension(pi);
		cleanupSessionResources("session-to-close");
		expect(close).toHaveBeenCalledWith("session-to-close");
		for (const handler of shutdownHandlers) await handler({}, {} as ExtensionContext);
		close.mockClear();
		cleanupSessionResources("after-shutdown");
		expect(close).not.toHaveBeenCalled();
	} finally {
		for (const handler of shutdownHandlers) await handler({}, {} as ExtensionContext);
		loadSpy.mockRestore();
		resetCompatCoordinator();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
