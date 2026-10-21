import { build } from "esbuild";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("addon/manifest.json", "utf8"));
if (manifest.version !== pkg.version)
  throw new Error("Package and addon versions must match");
if (process.env.Z2N_UPDATE_URL) {
  const url = new URL(process.env.Z2N_UPDATE_URL);
  if (url.protocol !== "https:") throw new Error("Update URL must use HTTPS");
  manifest.applications.zotero.update_url = url.toString();
}
const repository = new URL(pkg.repository.url.replace(/\.git$/, ""));
if (repository.protocol !== "https:" || repository.hostname !== "github.com")
  throw new Error("Set an HTTPS GitHub repository URL for release assets");

await rm("build", { recursive: true, force: true });
await cp("addon", "build", { recursive: true });
await writeFile(
  "build/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
await cp("LICENSE", "build/LICENSE");
await cp("THIRD_PARTY.md", "build/THIRD_PARTY.md");
await build({
  entryPoints: ["src/plugin.js"],
  bundle: true,
  format: "iife",
  target: "firefox140",
  outfile: "build/content/plugin.js",
});
await cp("src/preferences.js", "build/content/preferences.js");
await mkdir("dist", { recursive: true });
const out = `zotero2notion-${pkg.version}.xpi`;
await rm(`dist/${out}`, { force: true });
execFileSync("zip", ["-q", "-r", `../dist/${out}`, "."], { cwd: "build" });
const hash = createHash("sha256")
  .update(await readFile(`dist/${out}`))
  .digest("hex");
const { id, strict_min_version, strict_max_version } =
  manifest.applications.zotero;
const updates = {
  addons: {
    [id]: {
      updates: [
        {
          version: pkg.version,
          update_link: `${repository.href}/releases/download/v${pkg.version}/${out}`,
          update_hash: `sha256:${hash}`,
          applications: { zotero: { strict_min_version, strict_max_version } },
        },
      ],
    },
  },
};
await writeFile("dist/updates.json", JSON.stringify(updates, null, 2) + "\n");
console.log(`Built dist/${out} and dist/updates.json`);
