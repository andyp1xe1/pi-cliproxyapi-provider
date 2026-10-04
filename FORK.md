# Build-time transport fork

This fork removes the provider's runtime source lookup and rewriting. The
extension imports `@andyp1xe1/cliproxyapi-codex-transport`, a companion package
built from `@earendil-works/pi-ai` 0.85.1.

The transport works without an unpacked Pi installation. The published provider
tarball bundles the companion package. Git checkouts include its compiled code,
so production installs do not need patch tools, a compiler, or install scripts.

## Use the checkout

```sh
cd ~/dev/pi-cliproxyapi-provider
npm ci
npm run check
npm run test:package
```

Replace the upstream package entry in Pi's `settings.json` with the absolute
path to this checkout. Do not load both providers at once. If Nix manages the
settings file, change the package list in your Nix configuration instead of
editing its generated symlink.

This fork keeps the upstream configuration files, provider ID, login commands,
model cache, Fast mode, pause commands, and compaction behavior. Existing
CLIProxyAPI credentials do not need to change.

The supported host version range is Pi 0.85.1 through 0.85.x. Later host versions
need compatibility testing even though the transport itself is pinned.

## Build

```sh
npm run build
```

The build script:

1. Checks the npm dependency's version and the Codex source SHA-256.
2. Copies the dependency's compiled modules into a temporary directory.
3. Checks and applies `patches/pi-ai-0.85.1.patch` with `git apply`.
4. Bundles the transport and its supporting modules into a standalone ES module.
5. Rejects unbundled dependencies other than Node built-ins.
6. Writes the declarations and source, patch, and bundle hashes to the companion
   package's `dist` directory.

The installed dependency and the running Pi executable remain unchanged. The
build needs Git and Node 22.19 or later. It uses `esbuild-wasm`, so it does not
need an esbuild executable with a system-specific dynamic linker.

The generated files are committed for git and production installs. Rebuild them
when the patch or dependency changes. `npm run prepack` rebuilds before packaging.

## Patch contents

The patch preserves the upstream provider's changes:

- Accept proxy API keys without a ChatGPT account ID.
- Omit `chatgpt-account-id` when the token has no account ID.
- Recognize CLIProxyAPI and configured provider IDs when replaying tool calls.
- Emit `cliproxyapi-codex-responses` message metadata.
- Honor `CLIPROXYAPI_TRANSPORT`.
- Retry failed WebSocket connections before falling back to SSE.
- Keep the 30-minute idle timeout and `CLIPROXYAPI_WS_IDLE_TTL_MS` override.

The fork also fixes connection isolation. The upstream patch groups ordinary
proxy keys under an empty account ID. This fork keys cached connections by a
SHA-256 hash of the endpoint, provider ID, and credential. Changing any of these
opens a different connection, so a login change cannot silently reuse the old
proxy or account. The cache key does not expose the credential.

The bundled transport owns its WebSocket cache. The extension registers its
cleanup callback with the host Pi's session-resource registry and unregisters
that callback at shutdown. Compaction closes the companion package's connection,
not the host's separate Codex connection.

## Update the transport

Update the source alias, host development dependencies, expected version, source
hash, patch, and package version together. Review the changes, run the tests, and
commit the rebuilt package. Do not relax the source check to accommodate an
unreviewed release.

The unit tests cover key authentication, reasoning, usage, tool-call replay,
cancellation, WebSocket reuse and isolation, retries, idle timeout, and explicit cleanup.
`npm run test:package` installs a production tarball without development or peer
dependencies and exercises the standalone transport.

To also check an installed Pi CLI, including a compiled Nix build:

```sh
PI_TEST_CLI="$(command -v pi)" npm run test:package
```

This runs model listing with a temporary agent configuration. It does not use
live proxy credentials or change the user's Pi settings.

Unit tests use simulated responses. They do not establish compatibility with
every upstream model or measure production latency.
