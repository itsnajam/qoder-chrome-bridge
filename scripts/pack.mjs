import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = path.join(here, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const outDir = path.join(here, "dist");
const zipPath = path.join(outDir, `chrome-bridge-${pkg.version}.zip`);
fs.mkdirSync(outDir, { recursive: true });
const stage = fs.mkdtempSync(path.join(outDir, "stage-"));

const files = [
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

if (manifest.version !== pkg.version) {
  console.error(`manifest version ${manifest.version} does not match package version ${pkg.version}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
for (const file of files) {  fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
  fs.copyFileSync(path.join(ext, file), path.join(stage, file));
}

if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
execFileSync("zip", ["-q", "-r", zipPath, ...files], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`Packed ${path.relative(here, zipPath)} (${size} KB, version ${pkg.version})`);
