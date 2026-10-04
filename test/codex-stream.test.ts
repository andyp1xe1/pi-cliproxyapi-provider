import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "@andyp1xe1/cliproxyapi-codex-transport";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCliproxyCodexStreams } from "../extensions/codex-stream.ts";

const model: Model<Api> = {
	id: "gpt-5.4",
	name: "Test model",
	api: "cliproxyapi-codex-responses",
	provider: "cliproxyapi",
	baseUrl: "http://127.0.0.1:8317/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 16384,
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function responseEvents() {
	const item = {
		type: "message",
		id: "msg_test",
		role: "assistant",
		content: [{ type: "output_text", text: "hello" }],
	};
	return [
		{ type: "response.created", response: { id: "resp_test" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				output: [item],
				usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
			},
		},
	];
}

function requestBody(request: RequestInit) {
	const body =
		new Headers(request.headers).get("content-encoding") === "zstd"
			? zstdDecompressSync(request.body as Uint8Array).toString("utf8")
			: String(request.body);
	return JSON.parse(body);
}

function sseResponse() {
	return new Response(
		responseEvents()
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		},
	);
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Prebuilt Codex transport", () => {
	it("imports and streams in isolation without host pi-ai files or runtime patch writes", () => {
		const root = mkdtempSync(join(tmpdir(), "cpa-isolated-package-"));
		try {
			cpSync(fileURLToPath(new URL("../packages/codex-transport", import.meta.url)), join(root, "transport"), {
				recursive: true,
			});
			const entry = pathToFileURL(join(root, "transport/dist/index.js")).href;
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
				import { streamSimple } from ${JSON.stringify(entry)};
				const model = ${JSON.stringify(model)};
				const response = await streamSimple(model, ${JSON.stringify(context)}, {
					apiKey: "plain-proxy-key", transport: "sse", maxRetries: 0,
					fetch: async () => new Response(${JSON.stringify(
						responseEvents()
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
					)}, { status: 200 }),
				}).result();
				if (response.stopReason !== "stop") throw new Error(response.errorMessage);
				console.log(response.content[0].text);
			`,
				],
				{
					cwd: root,
					encoding: "utf8",
					timeout: 10000,
					env: { ...process.env, HOME: root, TMPDIR: root, NODE_PATH: "", CLIPROXYAPI_TRANSPORT: "sse" },
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("hello");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records the exact upstream version and build inputs", () => {
		const info = JSON.parse(
			readFileSync(new URL("../packages/codex-transport/dist/build-info.json", import.meta.url), "utf8"),
		);
		expect(info.upstreamVersion).toBe("0.85.1");
		expect(info.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(info.patchSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("accepts plain keys, omits the account header, and preserves reasoning and usage", async () => {
		const streams = await loadCliproxyCodexStreams();
		const fetchMock = vi.fn(async () => sseResponse());
		const result = await streams
			.streamSimple(model, context, {
				apiKey: "proxy-key",
				transport: "sse",
				reasoning: "high",
				fetch: fetchMock,
				maxRetries: 0,
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello" });
		expect(result.api).toBe("cliproxyapi-codex-responses");
		expect(result.usage).toMatchObject({ input: 8, output: 5, cacheRead: 2 });
		const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:8317/backend-api/codex/responses");
		expect(new Headers(request.headers).get("Authorization")).toBe("Bearer proxy-key");
		expect(new Headers(request.headers).has("chatgpt-account-id")).toBe(false);
		expect(requestBody(request).reasoning.effort).toBe("high");
	});

	it("preserves account headers for valid ChatGPT JWTs", async () => {
		const key = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64")}.signature`;
		const streams = await loadCliproxyCodexStreams();
		const fetchMock = vi.fn(async () => sseResponse());
		await streams.streamSimple(model, context, { apiKey: key, transport: "sse", fetch: fetchMock }).result();
		const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(new Headers(request.headers).get("chatgpt-account-id")).toBe("account-123");
	});

	it("preserves tool-call ids for a configurable provider", async () => {
		const customModel = { ...model, provider: "my-proxy" };
		const streams = await loadCliproxyCodexStreams([customModel.provider]);
		const toolContext: Context = {
			messages: [
				{
					role: "assistant",
					api: "cliproxyapi-codex-responses",
					provider: customModel.provider,
					model: model.id,
					content: [{ type: "toolCall", id: "call_123|fc_123", name: "read", arguments: { path: "README.md" } }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_123|fc_123",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const fetchMock = vi.fn(async () => sseResponse());
		await streams
			.streamSimple(customModel, toolContext, { apiKey: "proxy-key", transport: "sse", fetch: fetchMock })
			.result();
		const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const input = requestBody(request).input;
		expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_123", id: "fc_123" });
		expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_123" });
	});

	it("does not send an aborted request", async () => {
		const streams = await loadCliproxyCodexStreams();
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn(async () => sseResponse());
		const result = await streams
			.streamSimple(model, context, {
				apiKey: "proxy-key",
				transport: "sse",
				signal: controller.signal,
				fetch: fetchMock,
			})
			.result();
		expect(result.stopReason).toBe("aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reuses WebSockets, keeps the 30-minute idle timeout, and explicitly closes the cache", async () => {
		const sockets: FakeWebSocket[] = [];
		class FakeWebSocket extends EventTarget {
			readyState = 0;
			close = vi.fn(() => {
				this.readyState = 3;
			});
			constructor() {
				super();
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = 1;
					this.dispatchEvent(new Event("open"));
				});
			}
			send() {
				setTimeout(() => {
					for (const event of responseEvents())
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
				}, 0);
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const streams = await loadCliproxyCodexStreams();
			const options = {
				apiKey: "proxy-key",
				transport: "websocket-cached" as const,
				sessionId: "cache-test",
				maxRetries: 0,
			};
			expect((await streams.streamSimple(model, context, options).result()).stopReason).toBe("stop");
			expect((await streams.streamSimple(model, context, options).result()).stopReason).toBe("stop");
			expect(sockets).toHaveLength(1);
			expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 30 * 60 * 1000)).toBe(true);
			expect(getOpenAICodexWebSocketDebugStats("cache-test")).toMatchObject({
				connectionsCreated: 1,
				connectionsReused: 1,
			});
			streams.closeOpenAICodexWebSocketSessions("cache-test");
			expect(sockets[0].close).toHaveBeenCalledWith(1000, "debug_close");
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it.each([
		"endpoint",
		"credential",
		"provider",
	] as const)("does not reuse an authenticated WebSocket after changing the %s", async (change) => {
		const sockets: FakeWebSocket[] = [];
		class FakeWebSocket extends EventTarget {
			readyState = 0;
			close = vi.fn(() => {
				this.readyState = 3;
			});
			constructor(
				readonly url: string,
				readonly options: { headers: Record<string, string> },
			) {
				super();
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = 1;
					this.dispatchEvent(new Event("open"));
				});
			}
			send() {
				setTimeout(() => {
					for (const event of responseEvents())
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
				}, 0);
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const streams = await loadCliproxyCodexStreams(["cliproxyapi", "other-proxy"]);
		const options = {
			apiKey: "proxy-key",
			transport: "websocket-cached" as const,
			sessionId: `isolation-${change}`,
			maxRetries: 0,
			fetch: vi.fn(async () => {
				throw new Error("Unexpected HTTP fallback");
			}),
		};
		const nextModel = {
			...model,
			...(change === "endpoint" ? { baseUrl: "http://127.0.0.1:8318/backend-api" } : {}),
			...(change === "provider" ? { provider: "other-proxy" } : {}),
		};
		const nextOptions = { ...options, ...(change === "credential" ? { apiKey: "new-proxy-key" } : {}) };
		expect((await streams.streamSimple(model, context, options).result()).stopReason).toBe("stop");
		expect((await streams.streamSimple(nextModel, context, nextOptions).result()).stopReason).toBe("stop");
		expect(sockets).toHaveLength(2);
		expect(sockets[1].url).toBe(`${nextModel.baseUrl.replace(/^http:/, "ws:")}/codex/responses`);
		expect(new Headers(sockets[1].options.headers).get("Authorization")).toBe(`Bearer ${nextOptions.apiKey}`);
		expect((await streams.streamSimple(nextModel, context, nextOptions).result()).stopReason).toBe("stop");
		expect(sockets).toHaveLength(2);
		expect(options.fetch).not.toHaveBeenCalled();
		streams.closeOpenAICodexWebSocketSessions(options.sessionId);
		for (const socket of sockets) expect(socket.close).toHaveBeenCalledWith(1000, "debug_close");
	});

	it("honors the transport environment override and retries before falling back to SSE", async () => {
		let connections = 0;
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor() {
					connections++;
					throw new Error("Connection failed");
				}
			},
		);
		vi.stubEnv("CLIPROXYAPI_TRANSPORT", "websocket-cached");
		const streams = await loadCliproxyCodexStreams();
		const fetchMock = vi.fn(async () => sseResponse());
		const result = await streams
			.streamSimple(model, context, { apiKey: "proxy-key", transport: "sse", maxRetries: 2, fetch: fetchMock })
			.result();
		expect(result.stopReason).toBe("stop");
		expect(connections).toBe(3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
