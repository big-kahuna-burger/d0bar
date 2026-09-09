import { readFile, writeFile } from "node:fs/promises";

const version = process.env.RELEASE_VERSION;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version ?? "")) {
  throw new Error(
    "RELEASE_VERSION must be a SemVer version, for example 0.1.0 or 0.1.0-preview.0",
  );
}
if ((version.includes("-") ? "true" : "false") !== process.env.IS_PRERELEASE) {
  throw new Error("IS_PRERELEASE must match whether RELEASE_VERSION has a prerelease suffix");
}

const manifests = [
  "package.json",
  "packages/signals/package.json",
  "packages/frame-budget/package.json",
];

await Promise.all(
  manifests.map(async (file) => {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.version = version;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }),
);
