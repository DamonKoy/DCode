# Syncing with upstream T3 Code

DCode is a fork of [T3 Code](https://github.com/pingdotgg/t3code). Upstream lands dozens of
squash commits a day, so DCode takes all of `upstream/main` every few days instead of
cherry-picking. Every skipped commit becomes a future conflict, because later upstream work
builds on it.

## Merging

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git   # once
git fetch upstream main
git merge-tree --write-tree --name-only HEAD upstream/main          # preview conflicts, touches nothing
```

Merge on a branch in its own worktree, not in a checkout that has uncommitted work. Use
`git merge upstream/main`, not rebase: `main` is already published. Run
`git config rerere.enabled true` once so Git replays conflict resolutions it has seen before.

When resolving a conflict, take upstream's change and keep DCode's behavior on top. Upstream
often adds a capability gate or restructures a service that a DCode feature touches. Carry the
DCode feature into the new shape, for example by adding a new scan source to upstream's
parallel list or adding upstream's permission check to a DCode action. Do not revert
upstream's version.

Verify with the tests for the conflicted files and for DCode's own features. Then open a PR
into `main`.

## The product name

Source code keeps upstream's "T3 Code" text. The name changes to DCode while client bundles
are built:

- [`scripts/lib/product-name.ts`](../../scripts/lib/product-name.ts) is a Vite plugin. It runs
  for web, the desktop renderer, and the desktop main-process pack.
- [`apps/mobile/babel-plugin-product-name.js`](../../apps/mobile/babel-plugin-product-name.js)
  does the same for mobile.
- [`scripts/lib/product-name.json`](../../scripts/lib/product-name.json) holds both names.

Never rename "T3 Code" in source or tests. A hand rename once touched about 270 files and
caused most merge conflicts. It also broke tests, because protocol identities were renamed
along with the copy.

- **Server.** Not rewritten. Its "T3 Code" strings include protocol identities that must
  match upstream and the replay fixtures, such as Codex `clientInfo` and the MCP server name.
  Server messages a user sees therefore still say T3 Code.
- **Tests.** Vitest skips the plugin, so tests assert upstream's text.
- **New DCode copy.** Write "DCode" directly.
- **Translation tables keyed by English text** (for example
  [`settingsCopy.ts`](../../apps/web/src/components/settings/settingsCopy.ts)). Key them by
  the source text, "T3 Code".
- **Entry points that bypass the plugins.** These are the only places that name DCode in
  source: `productName` in `apps/desktop/package.json`, the product names in
  `scripts/build-desktop-artifact.ts`, and icons.
- **After changing the Babel plugin.** Start Metro once with `--clear`.

## Verification traps

These make tests fail for reasons unrelated to the merge:

- Node 23 fails SQLite-backed auth tests with "Provided value cannot be bound to SQLite
  parameter". The repository needs Node 24.
- Agent shells started by the desktop app inherit `ELECTRON_RUN_AS_NODE=1`, which fails the
  Windows payload probe in `build-desktop-artifact.test.ts`. Run tests with
  `env -u ELECTRON_RUN_AS_NODE`.
- Some registry mirrors time out on large tarballs such as `@effect/tsgo-*`. Install with
  `npm_config_registry=https://registry.npmjs.org/`, then discard any `pnpm-lock.yaml`
  change that only rewrites a deprecation message.
- Integration tests can time out when many suites run at once. Rerun one alone before
  treating it as a regression.
