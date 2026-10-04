// Print the registry/<id>.json entry for submitting this plugin to the GeoLibre
// plugin registry (https://github.com/opengeos/geolibre-plugins).
//
//   npm run package:geolibre
//   npm run registry:entry -- <release-zip-url> [--homepage <url>]
//
// <release-zip-url> is where the zip from `npm run package:geolibre` is
// published, normally a GitHub release asset. The entry pins that exact file by
// its SHA-256, so upload the zip this script hashed, unchanged. The
// release-plugin workflow runs this for you when you publish a release.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(rootDir, "geolibre-plugin");

const args = process.argv.slice(2);
const homepageIndex = args.indexOf("--homepage");
const homepage = homepageIndex === -1 ? undefined : args[homepageIndex + 1];
const url = args.find((arg, index) => !arg.startsWith("--") && index !== homepageIndex + 1);

if (!url || !/^https:\/\/\S+$/.test(url)) {
  console.error("Usage: npm run registry:entry -- <https release-zip-url> [--homepage <url>]");
  process.exit(2);
}

const manifest = JSON.parse(await readFile(join(bundleDir, "plugin.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const zipPath = join(bundleDir, `${manifest.id}-${manifest.version}.zip`);

let zip;
try {
  zip = await readFile(zipPath);
} catch {
  console.error(`${zipPath} not found; run npm run package:geolibre first.`);
  process.exit(1);
}

const author =
  typeof packageJson.author === "string" ? packageJson.author : packageJson.author?.name;
const repository =
  typeof packageJson.repository === "string"
    ? packageJson.repository
    : packageJson.repository?.url;
const repositoryUrl = repository?.replace(/^git\+/, "").replace(/\.git$/, "");

const entry = {
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  ...(manifest.description ? { description: manifest.description } : {}),
  // The template's placeholder author isn't worth submitting.
  ...(author && author !== "Your Name" ? { author } : {}),
  ...((homepage ?? repositoryUrl)?.startsWith("http")
    ? { homepage: homepage ?? repositoryUrl }
    : {}),
  manifestUrl: `plugins/${manifest.id}/plugin.json`,
  source: {
    url,
    sha256: createHash("sha256").update(zip).digest("hex"),
  },
};

console.log(JSON.stringify(entry, null, 2));
