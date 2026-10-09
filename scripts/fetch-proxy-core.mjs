import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, chmod } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = "v1.19.32";
const assets = {
  "mac-arm64": ["mihomo-darwin-arm64-v1.19.32.gz", "3312a6780652c622890fd4357c6a853bbf865464fd047ac7b7f52dab8de18652"],
  "mac-x64": ["mihomo-darwin-amd64-compatible-v1.19.32.gz", "18b382df77bded2ad0fb3db27db5636cb15b20729d5ba995a357eeb9b46bf507"],
  "win-x64": ["mihomo-windows-amd64-compatible-v1.19.32.zip", "974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0"],
};
const targets = process.argv.slice(2);
if (!targets.length || targets.some((target) => !assets[target]))
  throw new Error(`Usage: node scripts/fetch-proxy-core.mjs ${Object.keys(assets).join(" | ")}`);

for (const target of targets) {
  const [filename, expectedHash] = assets[target];
  const [platform, arch] = target.split("-");
  const directory = path.join(root, "vendor", "core", platform, arch);
  const executable = path.join(directory, platform === "win" ? "mihomo.exe" : "mihomo");
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, filename);
  if (!(await readFile(archive).catch(() => null))) {
    const result = spawnSync("curl", ["-fL", "--retry", "2", "--connect-timeout", "15", "-o", archive,
      `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${filename}`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "Mihomo download failed");
  }
  const bytes = await readFile(archive);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== expectedHash) {
    await rm(archive, { force: true });
    throw new Error(`Mihomo SHA-256 mismatch for ${filename}`);
  }
  if (platform === "mac") {
    await writeFile(executable, gunzipSync(bytes));
    await chmod(executable, 0o755);
  } else {
    let result = spawnSync("tar", ["-xf", archive, "-C", directory], { encoding: "utf8" });
    if (result.status !== 0 && process.platform === "win32") {
      const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
      result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(directory)} -Force`,
        ],
        { encoding: "utf8" },
      );
    }
    if (result.status !== 0) throw new Error(result.stderr || "Mihomo extraction failed");
    const extracted = (await readdir(directory)).find((entry) => entry.endsWith(".exe") && entry !== "mihomo.exe");
    if (extracted) await rename(path.join(directory, extracted), executable);
    if (!(await readFile(executable).catch(() => null))) throw new Error("Mihomo executable missing in archive");
  }
  process.stdout.write(`${target}: verified ${hash}\n`);
}
