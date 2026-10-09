import type { Plugin } from "vite-plus";

import productName from "./product-name.json" with { type: "json" };

/**
 * DCode keeps upstream T3 Code's source text and swaps the product name while
 * client bundles are built, so upstream merges never conflict on branding.
 * Used by the web (and desktop renderer) Vite build and the desktop main
 * process pack; mobile does the same in `apps/mobile/babel-plugin-product-name.js`.
 *
 * The server is not rewritten: its "T3 Code" strings include protocol
 * identities, such as Codex `clientInfo` and the MCP server name, that must
 * match upstream. Tests also see upstream text, so fixtures never change.
 */
export function productNamePlugin(): Plugin {
  const rename = (text: string) => text.replaceAll(productName.upstream, productName.name);
  return {
    name: "dcode-product-name",
    enforce: "pre",
    transform(code, id) {
      if (process.env.VITEST || id.includes("/node_modules/")) return null;
      if (!code.includes(productName.upstream)) return null;
      // Same line count, so existing source maps stay usable.
      return { code: rename(code), map: null };
    },
    transformIndexHtml(html) {
      return process.env.VITEST ? html : rename(html);
    },
  };
}
