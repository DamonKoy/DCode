import * as Schema from "effect/Schema";

class CatalogDependencyResolutionError extends Schema.TaggedError<CatalogDependencyResolutionError>()(
  "CatalogDependencyResolutionError",
  {
    workspacePackage: Schema.String,
    dependencyName: Schema.String,
    catalogSpec: Schema.String,
    catalogKey: Schema.String,
  },
) {
  override get message(): string {
    return `Unable to resolve '${this.catalogSpec}' for ${this.workspacePackage} dependency '${this.dependencyName}'. Expected key '${this.catalogKey}' in root workspace catalog.`;
  }
}

/**
 * Resolve `catalog:` dependency specs using the workspace catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 */
function catalogPackageName(selector: string): string {
  const selected = selector.split(">").at(-1) ?? selector;
  if (selected.startsWith("@")) {
    const slash = selected.indexOf("/");
    const versionAt = selected.indexOf("@", slash + 1);
    return versionAt === -1 ? selected : selected.slice(0, versionAt);
  }
  const versionAt = selected.indexOf("@");
  return versionAt === -1 ? selected : selected.slice(0, versionAt);
}

export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  workspacePackage: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      // An override key can be a selector such as `@scope/parent>effect` or
      // `undici@^8`. A bare `catalog:` means the catalog entry of the package
      // the selector ends in, without its version range.
      const lookupKey = catalogKey.length > 0 ? catalogKey : catalogPackageName(name);
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new CatalogDependencyResolutionError({
          workspacePackage,
          dependencyName: name,
          catalogSpec: spec,
          catalogKey: lookupKey,
        });
      }

      return [name, resolved];
    }),
  );
}
