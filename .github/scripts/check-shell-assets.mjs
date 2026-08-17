/* Guards the one failure mode that silently kills offline support.
 *
 * cache.addAll() in the service worker's install handler is atomic: if a
 * single listed URL 404s, the whole install rejects, no shell is cached, and
 * the app looks fine online and dies completely offline. You would not find
 * out until you were past Adam with no signal.
 *
 * This ran because roadbook.html was renamed to sheet.js. Nothing warned.
 *
 * Usage: node check-shell-assets.mjs <staged-site-dir>
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2] || "_site";
const fail = [];

const sw = readFileSync("sw.js", "utf8");
const block = sw.match(/const SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
if (!block) {
  console.error("Could not find SHELL_ASSETS in sw.js — has it been renamed?");
  process.exit(1);
}

/* Strip comments first: the array carries a /* … *​/ note containing quoted
   words, which would otherwise be read as asset paths. */
const listed = [...block[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/"([^"]+)"/g)]
  .map(m => m[1]);

console.log(`sw.js lists ${listed.length} shell assets`);
for (const a of listed) {
  const rel = a === "./" ? "index.html" : a.replace(/^\.\//, "");
  const ok = existsSync(join(site, rel));
  console.log(`  ${ok ? "ok  " : "MISS"}  ${a}`);
  if (!ok) fail.push(a);
}

/* Everything index.html pulls in must ship too. */
const html = readFileSync(join(site, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)]
  .map(m => m[1])
  .filter(r => !r.startsWith("downloads/"));   // linked, not required to boot
console.log(`index.html references ${refs.length} local files`);
for (const r of new Set(refs)) {
  const ok = existsSync(join(site, r));
  console.log(`  ${ok ? "ok  " : "MISS"}  ./${r}`);
  if (!ok) fail.push("./" + r);
}

/* The page this replaced must not come back from the dead. */
if (existsSync(join(site, "roadbook.html"))) {
  console.error("roadbook.html is back in the artifact — it was replaced by sheet.js");
  fail.push("roadbook.html");
}

if (fail.length) {
  console.error(`\n${fail.length} missing from the artifact: ${fail.join(", ")}`);
  console.error("The service worker would fail to install and offline would not work.");
  process.exit(1);
}
console.log("\nAll shell assets present.");
