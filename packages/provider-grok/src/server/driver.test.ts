import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeTargetedProviderUpdateAction } from "@t3tools/provider-core/server/maintenanceResolver";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      // `grok update` installs under GROK_HOME, so it must target this instance's home.
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  // An npm global install owns a `<prefix>/lib/node_modules/@xai-official/grok`
  // tree. `grok update` does not upgrade that tree, so the resolver must run
  // npm — otherwise the command that runs never matches the npm `latest` the
  // advisory compared against and the update reports `unchanged`.
  it.effect.skipIf(windowsHost || !symlinksSupported)(
    "upgrades an npm-owned install through npm",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-npm-" });
        const target = path.join(
          tempDir,
          "lib",
          "node_modules",
          "@xai-official",
          "grok",
          "bin",
          "grok.js",
        );
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, "#!/bin/sh\n");
        yield* fs.chmod(target, 0o755);
        const binaryPath = path.join(tempDir, "bin", "grok");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.symlink(target, binaryPath);

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-npm"),
          displayName: "Grok test",
          enabled: false,
          environment: [],
          config: { ...GrokDriver.defaultConfig(), binaryPath },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update?.executable).toBe("npm");
        expect(capabilities.update?.lockKey.startsWith("npm-global:")).toBe(true);
        expect(capabilities.update?.args).toEqual(
          expect.arrayContaining(["install", "-g", "@xai-official/grok@latest"]),
        );
        // A lock key the runner owns is what makes a pinned version installable.
        expect(makeTargetedProviderUpdateAction(capabilities, "1.0.50")?.args).toEqual(
          expect.arrayContaining(["@xai-official/grok@1.0.50"]),
        );
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      ),
  );
});
