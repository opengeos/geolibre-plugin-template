// Import styles
import './lib/styles/plugin-control.css';

// Main entry point - Core exports
export { PluginControl } from './lib/core/PluginControl';

// Type exports
export type {
  PluginControlOptions,
  PluginState,
  PluginControlEvent,
  PluginControlEventHandler,
} from './lib/core/types';

// GeoLibre host-plugin contract
export type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
  GeoLibreControl,
  GeoLibreMapControlPosition,
  GeoLibreNativeLayerRegistration,
  GeoLibreNativeLayerStyle,
  GeoLibreFeatureCollection,
  GeoLibreRightPanelRegistration,
} from './lib/geolibre/host-api';

// GeoLibre right-sidebar panel demonstration
export {
  RIGHT_PANEL_ID,
  registerTemplateRightPanel,
} from './lib/geolibre/right-panel';

// Deep-linking helpers
export {
  PLUGIN_DATA_PARAM,
  getPluginDataValue,
  maybeHandleDeepLink,
} from './lib/utils/deep-link';
export type { DeepLinkConsumer } from './lib/utils/deep-link';

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from './lib/utils';
