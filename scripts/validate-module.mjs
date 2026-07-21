import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const moduleDir = path.join(root, "modules", "dm-workshop-second-screen");
const manifestPath = path.join(moduleDir, "module.json");

const requiredPaths = [
  "module.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "scripts/second-screen.js",
  "styles/second-screen.css",
  "lang/en.json"
];

for (const relativePath of requiredPaths) {
  const fullPath = path.join(moduleDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required module path: ${relativePath}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const expected = {
  id: "dm-workshop-second-screen",
  title: "DM Workshop: Second Screen",
  version: "0.3.0-alpha.1",
  url: "https://github.com/formspire/DM-Workshop-Apps-Modules",
  manifest: "https://github.com/formspire/DM-Workshop-Apps-Modules/releases/download/v0.3.0-alpha.1/module.json",
  download: "https://github.com/formspire/DM-Workshop-Apps-Modules/releases/download/v0.3.0-alpha.1/module.zip",
  bugs: "https://github.com/formspire/DM-Workshop-Apps-Modules/issues"
};

for (const [key, value] of Object.entries(expected)) {
  if (manifest[key] !== value) {
    throw new Error(`module.json ${key} must be ${value}`);
  }
}

if (!Array.isArray(manifest.esmodules) || !manifest.esmodules.includes("scripts/second-screen.js")) {
  throw new Error("module.json must include scripts/second-screen.js in esmodules");
}

if (!Array.isArray(manifest.styles) || !manifest.styles.includes("styles/second-screen.css")) {
  throw new Error("module.json must include styles/second-screen.css in styles");
}

const readme = fs.readFileSync(path.join(moduleDir, "README.md"), "utf8");
for (const text of [
  "ALPHA RELEASE",
  "https://github.com/formspire/DM-Workshop-Apps-Modules/releases/download/v0.3.0-alpha.1/module.json",
  "https://ko-fi.com/dmworkshop",
  "Where imagination meets initiative."
]) {
  if (!readme.includes(text)) {
    throw new Error(`README.md is missing required text: ${text}`);
  }
}

console.log("Module validation passed.");
