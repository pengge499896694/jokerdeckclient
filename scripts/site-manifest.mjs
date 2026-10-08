import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const release = path.join(root, "release");
const files = await fs.readdir(release);
const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8");
const notes = changelog.split(`## v${pkg.version}\n`)[1]?.split("\n## ")[0]?.trim();
if (!notes) throw new Error(`CHANGELOG.md 缺少 v${pkg.version} 更新说明`);
const platformNames = {
  "windows-x86_64": `jokerdeck-switch-${pkg.version}-x64.exe`,
  "darwin-x86_64": `jokerdeck-switch-${pkg.version}-x64.dmg`,
  "darwin-aarch64": `jokerdeck-switch-${pkg.version}-arm64.dmg`,
};
const platforms = {};
for (const [platform, file] of Object.entries(platformNames)) {
  if (!files.includes(file)) throw new Error(`缺少 ${platform} 安装包`);
  const bytes = await fs.readFile(path.join(release, file));
  platforms[platform] = {
    url: `https://jokerdeck.de5.net/client/download/${file}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
const manifest = {
  version: pkg.version,
  notes,
  platforms,
};
await fs.writeFile(
  path.join(release, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await fs.writeFile(path.join(release, "release-notes.md"), `${notes}\n`);
console.log(`已生成 v${pkg.version} 清单和更新说明`);
