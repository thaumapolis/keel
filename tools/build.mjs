#!/usr/bin/env node
/**
 * Assemble the single self-contained index.html.
 *
 * Concatenation, not a bundler. The artifact has to run from file:// and inside a
 * sandboxed opaque-origin iframe, and a module script is blocked in both -- so the
 * JS must be inline classic script, which means modules are concatenated into one
 * shared scope in dependency order. Same approach as the rest of the org, and the
 * same guarantees asserted rather than assumed: dependency order, no two modules
 * declaring the same top-level name (legal across modules, fatal in one scope, and
 * presents as a blank page), and every placeholder consumed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Dependency order: leaves first. ui.js boots last and drives everything.
const MODULES = ["quad.js", "hull.js", "columns.js", "sections.js", "stability.js", "view3d.js", "app.js", "ui.js"];

function fromRelativeModule(statement) {
  return /^import\s+\{[\s\S]*?\}\s*from\s+"\.\/[^"]+";?\s*$/.test(statement.replace(/\s+/g, " "));
}
function findImportEnd(lines, start) {
  for (let j = start; j < lines.length; j += 1) {
    if (/\}\s*from\s+"[^"]+";?\s*$/.test(lines[j])) return j;
  }
  return -1;
}

function stripModuleSyntax(source, name) {
  const lines = source.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^import\s+\{/.test(line)) {
      const closed = findImportEnd(lines, i);
      if (closed === -1) {
        throw new Error(`${name}: could not find the end of the import at line ${i + 1}; ` +
          `this bundler handles only relative named imports, e.g. import { a, b } from "./x.js";`);
      }
      if (!fromRelativeModule(lines.slice(i, closed + 1).join(" "))) {
        throw new Error(`${name}: import at line ${i + 1} is not from a relative ./ module`);
      }
      i = closed;
      continue;
    }
    if (/^import\s/.test(line)) throw new Error(`${name}: unsupported import form: ${line}`);
    if (/^export\s*\{/.test(line)) {
      // Re-export -- allowed to be dropped since everything shares one scope, but
      // view3d's `export { project as _project }` is a rename the scope can't do,
      // so reject rather than silently drop a binding a module might use.
      throw new Error(`${name}: re-export (${line.trim()}) is not supported; call through a function instead`);
    }
    if (/^export\s+(class|function|const|let)\s/.test(line)) {
      kept.push(line.replace(/^export\s+/, ""));
      continue;
    }
    if (/^export\b/.test(line)) throw new Error(`${name}: unsupported export form: ${line}`);
    kept.push(line);
  }
  return kept.join("\n");
}

function assertNoTopLevelCollisions(sources) {
  const declared = new Map();
  for (const [name, source] of sources) {
    for (const m of source.matchAll(/^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const prev = declared.get(m[1]);
      if (prev !== undefined && prev !== name) {
        throw new Error(`top-level name "${m[1]}" is declared in both ${prev} and ${name}`);
      }
      declared.set(m[1], name);
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDir = join(root, "src");

const sources = MODULES.map((name) => [name, stripModuleSyntax(readFileSync(join(srcDir, name), "utf8"), name)]);
assertNoTopLevelCollisions(sources);

// Sanity: every module's own top-level imports should resolve to a module that
// appears EARLIER in MODULES. Dependency order is the other half of the promise.
const order = new Map(MODULES.map((n, i) => [n, i]));
for (const [name, source] of sources) {
  for (const m of source.matchAll(/from\s+"\.\/([\w.]+)"/g)) {
    if (order.get(m[1]) === undefined || order.get(m[1]) >= order.get(name)) {
      throw new Error(`${name} depends on ${m[1]}, which is not earlier in MODULES order`);
    }
  }
}

const bundle = sources.map(([, s]) => s).join("\n\n");
const template = readFileSync(join(root, "template.html"), "utf8");
if (!template.includes("/*__KEEL_BUNDLE__*/")) throw new Error("template.html is missing the bundle placeholder");
const out = template.replace("/*__KEEL_BUNDLE__*/", bundle);

const target = process.argv[2] ? resolve(process.argv[2]) : join(root, "index.html");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out);
console.log(`wrote ${target} (${(out.length / 1024).toFixed(1)} KB, ${MODULES.length} modules)`);
