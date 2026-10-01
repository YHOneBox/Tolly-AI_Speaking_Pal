import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icons = path.join(root, "src-tauri", "icons");

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.copyFileSync(path.join(icons, "128x128.png"), path.join(root, "public", "icon.png"));

fs.rmSync(path.join(icons, "android"), { recursive: true, force: true });
fs.rmSync(path.join(icons, "ios"), { recursive: true, force: true });
for (const name of fs.readdirSync(icons)) {
  if (name.startsWith("Square") || name === "StoreLogo.png") {
    fs.rmSync(path.join(icons, name), { force: true });
  }
}

console.log("Copied the window icon and kept the desktop icon set.");
