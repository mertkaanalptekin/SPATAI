// Writes dist/.source-hash so launch.py can tell whether the bundled UI matches the sources.
// Keep the algorithm identical to ui_source_hash() in launch.py.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SOURCES = ["src", "index.html", "package.json", "vite.config.ts"];
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(join(p, n))) : [p]);
const rel = (f) => relative(root, f).split(sep).join("/");
const files = SOURCES.map((s) => join(root, s)).filter(existsSync).flatMap(walk);
files.sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));
const h = createHash("sha256");
for (const f of files) {
  h.update(Buffer.concat([Buffer.from(rel(f)), Buffer.from([0])]));
  const data = Buffer.from(readFileSync(f).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  h.update(Buffer.concat([data, Buffer.from([0])]));
}
writeFileSync(join(root, "dist", ".source-hash"), h.digest("hex") + "\n");
