import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "cliproxyapi-package-test-"));
const exec = (command, args, options = {}) =>
	execFileSync(command, args, {
		encoding: "utf8",
		timeout: 120000,
		...options,
	});
try {
	exec("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
	const [packed] = JSON.parse(
		exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root }),
	);
	assert(packed.bundled.includes("@andyp1xe1/cliproxyapi-codex-transport"), "Transport missing from npm tarball");
	await writeFile(
		join(temp, "package.json"),
		JSON.stringify({ name: "isolated-package-test", private: true, type: "module" }),
	);
	exec(
		"npm",
		[
			"install",
			join(temp, packed.filename),
			"--ignore-scripts",
			"--omit=dev",
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
		],
		{ cwd: temp, stdio: "inherit" },
	);
	for (const dependency of ["@earendil-works/pi-ai", "@andyp1xe1/pi-ai-source", "esbuild-wasm"]) {
		assert(!existsSync(join(temp, "node_modules", dependency)), `Unexpected production dependency: ${dependency}`);
	}
	const providerDir = join(temp, "node_modules", "@andyp1xe1", "pi-cliproxyapi-provider");
	exec(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import assert from "node:assert/strict";
		import { streamSimple, registerCodexToolCallProviders } from "@andyp1xe1/cliproxyapi-codex-transport";
		registerCodexToolCallProviders(["custom-proxy"]);
		let called = false;
		const result = await streamSimple({ id: "test", provider: "custom-proxy", baseUrl: "http://127.0.0.1:8317/backend-api", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { messages: [] }, {
			apiKey: "plain-proxy-key", transport: "sse", maxRetries: 0,
			fetch: async (_url, request) => {
				called = true;
				assert.equal(new Headers(request.headers).get("Authorization"), "Bearer plain-proxy-key");
				assert.equal(new Headers(request.headers).has("chatgpt-account-id"), false);
				return new Response("deliberate test error", { status: 400 });
			},
		}).result();
		assert(called, result.errorMessage);
		assert.equal(result.api, "cliproxyapi-codex-responses");
	`,
		],
		{ cwd: providerDir, env: { ...process.env, HOME: temp, TMPDIR: temp, CLIPROXYAPI_TRANSPORT: "sse" } },
	);
	// Optional integration check against an installed Pi CLI, including compiled Bun/Nix hosts.
	if (process.env.PI_TEST_CLI) {
		const agentDir = join(temp, "agent");
		await mkdir(agentDir);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [providerDir],
			}),
		);
		const result = spawnSync(process.env.PI_TEST_CLI, ["--list-models"], {
			cwd: temp,
			encoding: "utf8",
			timeout: 30000,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				CLIPROXYAPI_API_KEY: "",
				CLIPROXYAPI_BASE_URL: "",
			},
		});
		const output = `${result.stdout || ""}\n${result.stderr || ""}`;
		assert.equal(result.status, 0, output);
		assert(!/failed to|Cannot resolve|Error loading extension/i.test(output), output);
		assert(
			output.includes("[pi-cliproxyapi-provider] not configured yet"),
			`Extension did not initialize:\n${output}`,
		);
		console.log("Installed Pi loaded the fork without an unpacked pi-ai dependency.");
	}
	console.log(`Production tarball passed: ${packed.filename}`);
} finally {
	await rm(temp, { recursive: true, force: true });
}
