/**
 * Deep-linking support for the GeoLibre integration: a plugin can be opened with
 * a value preloaded by adding a query parameter to the GeoLibre URL, e.g.
 * `https://geolibre.app/?plugin-data=https://example.com/dataset.zip`.
 *
 * GeoLibre auto-activates a plugin when a URL carries a parameter the plugin
 * declared in `urlParameterNames`, then dispatches the parsed query parameters
 * to the plugin's `handleUrlParameters(app, params)` hook. These helpers operate
 * purely on a `URLSearchParams`, with no DOM or MapLibre imports, so the logic
 * can be unit-tested in isolation.
 *
 * Rename {@link PLUGIN_DATA_PARAM} and adapt {@link DeepLinkConsumer} to whatever
 * your plugin needs to receive (a dataset URL, a feature id, a view state, ...).
 */

/** Query-parameter name this plugin owns. Rename for your plugin. */
export const PLUGIN_DATA_PARAM = "plugin-data";

/**
 * Extract the deep-link value from parsed query parameters. Returns the trimmed
 * value, or `null` when the parameter is absent or blank.
 */
export function getPluginDataValue(params: URLSearchParams): string | null {
  const trimmed = params.get(PLUGIN_DATA_PARAM)?.trim();
  return trimmed ? trimmed : null;
}

/** Minimal structural type for whatever consumes the deep-link value. */
export interface DeepLinkConsumer {
  loadFromUrl(value: string): Promise<void> | void;
}

/**
 * If the query parameters carry a {@link PLUGIN_DATA_PARAM} value, forward it to
 * the consumer. No-op when the parameter is absent or blank. Returns the
 * consumer's promise (if any) so callers can await completion.
 */
export async function maybeHandleDeepLink(
  consumer: DeepLinkConsumer,
  params: URLSearchParams,
): Promise<void> {
  const value = getPluginDataValue(params);
  if (value) await consumer.loadFromUrl(value);
}
