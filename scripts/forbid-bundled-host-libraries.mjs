// Build guard for the GeoLibre plugin bundle: fail when a library the host
// already provides would be bundled into the plugin.
//
// deck.gl and luma.gl throw when a second copy loads into the same page
// (luma.gl: "already initialized") and share global singletons, so a plugin
// must use the host's copy (`app.getDeckGL()`, `app.getMaplibreGlRaster()`,
// `app.getMaplibreGlLidar()`) and import these packages for their types only.
// Type-only imports are erased before bundling, so they never reach this hook.

/** Package names (and scopes, ending in "/") the host provides. */
export const HOST_PROVIDED_PACKAGES = [
  "@deck.gl/",
  "deck.gl",
  "@luma.gl/",
  "maplibre-gl-raster",
  "maplibre-gl-lidar",
];

/**
 * Whether an import specifier names a host-provided package (or one of its
 * subpaths). Relative and absolute paths never match.
 *
 * @param {string} id - The import specifier.
 * @param {string[]} [packages] - The packages to match.
 * @returns {string | null} The matched package, or null.
 */
export function hostProvidedPackage(id, packages = HOST_PROVIDED_PACKAGES) {
  if (!id || id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return null;
  for (const name of packages) {
    if (name.endsWith("/") ? id.startsWith(name) : id === name || id.startsWith(`${name}/`)) {
      return name;
    }
  }
  return null;
}

/**
 * A Vite/Rollup plugin that fails the build on a value import of a
 * host-provided package.
 *
 * @param {{ packages?: string[] }} [options] - Override the package list.
 * @returns {import("vite").Plugin}
 */
export function forbidBundledHostLibraries(options = {}) {
  const packages = options.packages ?? HOST_PROVIDED_PACKAGES;
  return {
    name: "geolibre-plugin:forbid-bundled-host-libraries",
    enforce: "pre",
    resolveId(id, importer) {
      const name = hostProvidedPackage(id, packages);
      if (!name) return null;
      this.error(
        `"${id}"${importer ? ` (imported by ${importer})` : ""} is provided by the GeoLibre ` +
          `host and must not be bundled: a second deck.gl/luma.gl copy fails to render. ` +
          `Import it with "import type" and get the module at runtime from the host ` +
          `(app.getDeckGL(), app.getMaplibreGlRaster(), app.getMaplibreGlLidar()).`,
      );
    },
  };
}
