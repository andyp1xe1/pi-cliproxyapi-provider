/** CLIProxyAPI adapters around the prebuilt, version-pinned Codex transport. */
import {
	closeOpenAICodexWebSocketSessions,
	stream as codexStream,
	streamSimple as codexStreamSimple,
	registerCodexToolCallProviders,
} from "@andyp1xe1/cliproxyapi-codex-transport";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const CLIPROXYAPI_CODEX_API = "cliproxyapi-codex-responses" as const;

export type CliproxyCodexStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CloseCodexWebSocketSessions = (sessionId?: string) => void;

export type CliproxyCodexStreams = {
	streamSimple: CliproxyCodexStreamSimple;
	stream: CliproxyCodexStreamSimple;
	rawStreamSimple: CliproxyCodexStreamSimple;
	rawStream: CliproxyCodexStreamSimple;
	api: typeof CLIPROXYAPI_CODEX_API;
	closeOpenAICodexWebSocketSessions: CloseCodexWebSocketSessions;
};

export interface CliproxyCodexStreamOptions {
	shouldUseFast?: (model: Model<Api>) => boolean;
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

interface TranscriptMessage {
	role?: string;
	content?: unknown;
	sections?: Record<string, string | null | undefined>;
	toolsAdded?: unknown[];
	toolsRemoved?: Array<{ name: string }>;
	[key: string]: unknown;
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text.trim())
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/** Convert system-message transcripts into the classic Context used by the pinned transport. */
export function adaptTranscriptContext(context: Context | { messages?: unknown[]; [key: string]: unknown }): Context {
	if (!context || !Array.isArray(context.messages)) {
		return context as Context;
	}

	const rawMessages = context.messages as TranscriptMessage[];
	if (!rawMessages.some((m) => m && m.role === "system")) {
		return context as Context;
	}

	let leadingText = "";
	const sections = new Map<string, string>();
	const toolsMap = new Map<string, unknown>();

	if (Array.isArray(context.tools)) {
		for (const tool of context.tools) {
			if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
				toolsMap.set(tool.name, tool);
			}
		}
	}

	const nonSystemMessages: unknown[] = [];
	for (const msg of rawMessages) {
		if (!msg || typeof msg !== "object") continue;
		if (msg.role === "system") {
			const text = extractContentText(msg.content);
			if (text) leadingText = leadingText ? `${leadingText}\n\n${text}` : text;
			if (msg.sections && typeof msg.sections === "object") {
				for (const [name, sectionText] of Object.entries(msg.sections)) {
					if (sectionText === null || sectionText === undefined) {
						sections.delete(name);
					} else if (typeof sectionText === "string" && sectionText.trim()) {
						sections.set(name, sectionText.trim());
					}
				}
			}
			if (Array.isArray(msg.toolsRemoved)) {
				for (const tool of msg.toolsRemoved) {
					if (tool && typeof tool.name === "string") toolsMap.delete(tool.name);
				}
			}
			if (Array.isArray(msg.toolsAdded)) {
				for (const tool of msg.toolsAdded) {
					if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
						toolsMap.set(tool.name, tool);
					}
				}
			}
		} else {
			nonSystemMessages.push(msg);
		}
	}

	const extractedSystemPrompt = [leadingText, ...sections.values()].filter(Boolean).join("\n\n");
	const finalSystemPrompt =
		extractedSystemPrompt || (typeof context.systemPrompt === "string" ? context.systemPrompt : undefined);
	const finalTools =
		toolsMap.size > 0
			? [...toolsMap.values()]
			: Array.isArray(context.tools) && context.tools.length > 0
				? context.tools
				: undefined;
	return {
		...(context as Record<string, unknown>),
		systemPrompt: finalSystemPrompt,
		tools: finalTools as Context["tools"],
		messages: nonSystemMessages as Context["messages"],
	};
}

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return { ...(payload as Record<string, unknown>), service_tier: "priority" };
}

/** Apply Fast before Pi's payload hooks so later extensions retain final control. */
export async function applyFastPayloadHook(
	payload: unknown,
	model: Model<Api>,
	onPayload?: PayloadHook,
): Promise<unknown> {
	const fastPayload = withPriorityServiceTier(payload);
	const nextPayload = await onPayload?.(fastPayload, model);
	return nextPayload === undefined ? fastPayload : nextPayload;
}

export function wrapStreamSimpleForFast(
	streamSimple: CliproxyCodexStreamSimple,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamSimple {
	return (model, context, options) => {
		if (!shouldUseFast?.(model)) return streamSimple(model, context, options);
		return streamSimple(model, context, {
			...options,
			onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, options?.onPayload),
		});
	};
}

export async function loadCliproxyCodexStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	registerCodexToolCallProviders(providerIds);
	const rawStreamSimple: CliproxyCodexStreamSimple = (model, context, streamOptions) =>
		codexStreamSimple(model, adaptTranscriptContext(context), streamOptions);
	const rawStream: CliproxyCodexStreamSimple = (model, context, streamOptions) =>
		codexStream(model, adaptTranscriptContext(context), streamOptions);
	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple: wrapStreamSimpleForFast(rawStreamSimple, options.shouldUseFast),
		stream: wrapStreamSimpleForFast(rawStream, options.shouldUseFast),
		rawStreamSimple,
		rawStream,
		closeOpenAICodexWebSocketSessions,
	};
}
