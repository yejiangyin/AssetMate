import fs from 'node:fs';
import path from 'node:path';

const rollupCandidates = [
  path.resolve('node_modules/rollup/dist/native.js'),
  ...findPnpmFiles('rollup@', 'node_modules/rollup/dist/native.js'),
];

const lightningCssCandidates = [
  path.resolve('node_modules/lightningcss/node/index.js'),
  ...findPnpmFiles('lightningcss@', 'node_modules/lightningcss/node/index.js'),
];

const rollupFallbackSnippet = `const loadBindings = () => {
\ttry {
\t\treturn requireWithFriendlyError(existsSync(path.join(__dirname, localName)) ? localName : \`@rollup/rollup-\${packageBase}\`);
\t} catch (error) {
\t\ttry {
\t\t\treturn require(path.join(process.cwd(), 'node_modules', '.pnpm', \`@rollup+rollup-\${packageBase}@\${require('../package.json').version}\`, 'node_modules', '@rollup', \`rollup-\${packageBase}\`));
\t\t} catch {}
\t\ttry {
\t\t\treturn require('@rollup/wasm-node');
\t\t} catch {
\t\t\tthrow error;
\t\t}
\t}
};

const { parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16 } = loadBindings();`;

let sawRollupFile = false;
let handledRollupPatch = false;

for (const file of rollupCandidates) {
  if (!fs.existsSync(file)) {
    continue;
  }
  sawRollupFile = true;

  const source = fs.readFileSync(file, 'utf8');

  const targetSnippet =
    "const { parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16 } = requireWithFriendlyError(\n" +
    "\texistsSync(path.join(__dirname, localName)) ? localName : `@rollup/rollup-${packageBase}`\n" +
    ");";

  const oldFallbackSnippet = `const loadBindings = () => {
\ttry {
\t\treturn requireWithFriendlyError(existsSync(path.join(__dirname, localName)) ? localName : \`@rollup/rollup-\${packageBase}\`);
\t} catch (error) {
\t\ttry {
\t\t\treturn require('@rollup/wasm-node');
\t\t} catch {
\t\t\tthrow error;
\t\t}
\t}
};

const { parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16 } = loadBindings();`;

  if (source.includes(rollupFallbackSnippet)) {
    handledRollupPatch = true;
    continue;
  }

  if (source.includes(targetSnippet)) {
    fs.writeFileSync(file, source.replace(targetSnippet, rollupFallbackSnippet));
    handledRollupPatch = true;
    continue;
  }

  if (source.includes(oldFallbackSnippet)) {
    fs.writeFileSync(file, source.replace(oldFallbackSnippet, rollupFallbackSnippet));
    handledRollupPatch = true;
  }
}

const lightningCssTargetSnippet = `} else {
  try {
    module.exports = require(\`lightningcss-\${parts.join('-')}\`);
  } catch (err) {
    module.exports = require(\`../lightningcss.\${parts.join('-')}.node\`);
  }
}`;

const lightningCssFallbackSnippet = `} else {
  try {
    module.exports = require(\`lightningcss-\${parts.join('-')}\`);
  } catch (err) {
    try {
      module.exports = require(require('node:path').join(process.cwd(), 'node_modules', '.pnpm', \`lightningcss-\${parts.join('-')}@\${require('../package.json').version}\`, 'node_modules', \`lightningcss-\${parts.join('-')}\`));
    } catch {
      try {
        module.exports = require(require('node:path').join(__dirname, '..', '..', \`lightningcss-\${parts.join('-')}\`));
      } catch {
        module.exports = require(\`../lightningcss.\${parts.join('-')}.node\`);
      }
    }
  }
}`;

const oldLightningCssFallbackSnippet = `} else {
  try {
    module.exports = require(\`lightningcss-\${parts.join('-')}\`);
  } catch (err) {
    try {
      module.exports = require(require('node:path').join(__dirname, '..', '..', \`lightningcss-\${parts.join('-')}\`));
    } catch {
      module.exports = require(\`../lightningcss.\${parts.join('-')}.node\`);
    }
  }
}`;

let sawLightningCssFile = false;
let handledLightningCssPatch = false;

for (const file of lightningCssCandidates) {
  if (!fs.existsSync(file)) {
    continue;
  }
  sawLightningCssFile = true;

  const source = fs.readFileSync(file, 'utf8');
  if (source.includes("process.cwd(), 'node_modules', '.pnpm', `lightningcss-")) {
    handledLightningCssPatch = true;
    continue;
  }

  if (source.includes(lightningCssTargetSnippet)) {
    fs.writeFileSync(file, source.replace(lightningCssTargetSnippet, lightningCssFallbackSnippet));
    handledLightningCssPatch = true;
    continue;
  }

  if (source.includes(oldLightningCssFallbackSnippet)) {
    fs.writeFileSync(file, source.replace(oldLightningCssFallbackSnippet, lightningCssFallbackSnippet));
    handledLightningCssPatch = true;
  }
}

if (sawRollupFile && !handledRollupPatch) {
  throw new Error('Rollup native patch failed: native.js snippet did not match the expected Rollup versions.');
}

if (sawLightningCssFile && !handledLightningCssPatch) {
  throw new Error('Lightning CSS native patch failed: node/index.js snippet did not match the expected versions.');
}

function findPnpmFiles(prefix, suffix) {
  const pnpmRoot = path.resolve('node_modules/.pnpm');
  if (!fs.existsSync(pnpmRoot)) {
    return [];
  }

  return fs
    .readdirSync(pnpmRoot)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(pnpmRoot, entry, suffix));
}
