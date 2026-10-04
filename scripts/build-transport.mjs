import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild-wasm";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@andyp1xe1/pi-ai-source"))));
const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
const upstreamVersion = "0.85.1";
const sourceSha256 = "f5705d45ae72102110238d6265a548df3aef50b777f654f1f91a32d563c91b3e";
const relativeEntry = "dist/api/openai-codex-responses.js";
const patchPath = join(root, "patches", `pi-ai-${upstreamVersion}.patch`);
const outputDir = join(root, "packages", "codex-transport", "dist");
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

if (sourcePackage.name !== "@earendil-works/pi-ai" || sourcePackage.version !== upstreamVersion) {
	throw new Error(`Expected pi-ai ${upstreamVersion}, received ${sourcePackage.name}@${sourcePackage.version}`);
}
const source = await readFile(join(sourceRoot, relativeEntry));
if (sha256(source) !== sourceSha256) {
	throw new Error("Upstream Codex source changed. Review the patch before rebuilding.");
}

const stagingDir = await mkdtemp(join(tmpdir(), "cliproxyapi-transport-build-"));
try {
	await cp(join(sourceRoot, "dist"), join(stagingDir, "dist"), { recursive: true });
	// Work on a copy. Never modify the installed dependency or the running Pi binary.
	for (const args of [["--check", "--whitespace=error-all"], ["--whitespace=error-all"]]) {
		execFileSync("git", ["apply", ...args, patchPath], { cwd: stagingDir, stdio: "pipe" });
	}
	const result = await build({
		absWorkingDir: root,
		entryPoints: [join(stagingDir, relativeEntry)],
		outfile: join(outputDir, "index.js"),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		write: false,
		metafile: true,
		legalComments: "eof",
		minifyWhitespace: true,
		nodePaths: [join(sourceRoot, "node_modules"), join(root, "node_modules")],
		banner: {
			js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
		},
	});
	for (const output of Object.values(result.metafile.outputs)) {
		for (const dependency of output.imports) {
			if (!dependency.path.startsWith("node:")) {
				throw new Error(`Transport must be self-contained. Unbundled import: ${dependency.path}`);
			}
		}
	}
	// Whitespace minification removes machine-specific source-path comments.
	const normalizedBundle = result.outputFiles[0].text;
	await mkdir(outputDir, { recursive: true });
	await writeFile(join(outputDir, "index.js"), normalizedBundle);
	await cp(join(root, "packages", "codex-transport", "index.d.ts"), join(outputDir, "index.d.ts"));
	await writeFile(
		join(outputDir, "build-info.json"),
		`${JSON.stringify(
			{
				upstreamPackage: sourcePackage.name,
				upstreamVersion,
				sourceSha256,
				patchSha256: sha256(await readFile(patchPath)),
				bundleSha256: sha256(normalizedBundle),
			},
			null,
			2,
		)}\n`,
	);
	console.log(
		`Built CLIProxyAPI transport from pi-ai ${upstreamVersion}: ${Buffer.byteLength(normalizedBundle)} bytes`,
	);
} finally {
	await rm(stagingDir, { recursive: true, force: true });
}
