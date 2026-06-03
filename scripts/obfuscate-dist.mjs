import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = process.cwd();
const assetsDir = path.join(root, "dist", "assets");
const files = await readdir(assetsDir);
const appBundles = files
  .filter((file) => /^index-[\w-]+\.js$/.test(file))
  .sort();

if (!appBundles.length) {
  throw new Error("No application bundle found in dist/assets.");
}

for (const file of appBundles) {
  const filePath = path.join(assetsDir, file);
  const source = await readFile(filePath, "utf8");
  const result = JavaScriptObfuscator.obfuscate(source, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.35,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    sourceMap: false,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.35,
    stringArrayEncoding: ["base64"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: "variable",
    stringArrayThreshold: 0.75,
    target: "browser",
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  });
  await writeFile(filePath, result.getObfuscatedCode(), "utf8");
  console.log(`Obfuscated ${path.relative(root, filePath)}`);
}
