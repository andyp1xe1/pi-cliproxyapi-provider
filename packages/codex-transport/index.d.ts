import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type CodexStream = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export declare const stream: CodexStream;
export declare const streamSimple: CodexStream;
export declare function registerCodexToolCallProviders(providerIds: string[]): void;
export declare function closeOpenAICodexWebSocketSessions(sessionId?: string): void;
export declare function getOpenAICodexWebSocketDebugStats(sessionId: string):
	| {
			requests: number;
			connectionsCreated: number;
			connectionsReused: number;
			cachedContextRequests: number;
			storeTrueRequests: number;
			fullContextRequests: number;
			deltaRequests: number;
			lastInputItems: number;
			websocketFailures: number;
			sseFallbacks: number;
	  }
	| undefined;
export declare function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void;
