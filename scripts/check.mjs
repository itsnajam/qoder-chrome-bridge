import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = path.join(here, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const publicFiles = ["manifest.json", "background.js", "popup.html", "popup.js", "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"];

const problems = [];

if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} does not match package version ${pkg.version}`);
for (const file of publicFiles) {
  if (!fs.existsSync(path.join(ext, file))) problems.push(`missing extension file: ${file}`);
}

let token = "";
try {
  token = fs.readFileSync(path.join(here, "token"), "utf8").trim();
} catch {}
if (token) {
  for (const file of ["manifest.json", "background.js", "popup.html", "popup.js"]) {
    if (fs.readFileSync(path.join(ext, file), "utf8").includes(token)) problems.push(`the bridge token appears in extension/${file}`);
  }
}

if (problems.length) {
  console.error("Check failed:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log(`Check passed: ${publicFiles.length} extension files, version ${manifest.version}, no token in the package.`);
