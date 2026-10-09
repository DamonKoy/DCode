// Mobile counterpart of `scripts/lib/product-name.ts`: app source keeps
// upstream's "T3 Code" text and the bundle shows DCode's product name.
const productName = require("../../scripts/lib/product-name.json");

const rename = (text) => text.replaceAll(productName.upstream, productName.name);

module.exports = function productNamePlugin() {
  return {
    name: "dcode-product-name",
    visitor: {
      Program(path, state) {
        if (state.filename?.includes("/node_modules/")) path.stop();
      },
      StringLiteral(path) {
        if (path.node.value.includes(productName.upstream)) {
          path.node.value = rename(path.node.value);
        }
      },
      JSXText(path) {
        if (path.node.value.includes(productName.upstream)) {
          path.node.value = rename(path.node.value);
        }
      },
      TemplateElement(path) {
        const { value } = path.node;
        if (value.raw.includes(productName.upstream)) {
          path.node.value = {
            raw: rename(value.raw),
            cooked: value.cooked == null ? value.cooked : rename(value.cooked),
          };
        }
      },
    },
  };
};
