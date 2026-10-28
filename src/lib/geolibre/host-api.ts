/**
 * Canonical GeoLibre host-plugin contract.
 *
 * This module is the single source of truth for the interface between a plugin
 * and the GeoLibre host application. The GeoLibre wrapper in `src/geolibre.ts`
 * imports these types instead of redeclaring them, and downstream plugins built
 * from this template should do the same.
 *
 * The contract is intentionally free of MapLibre and React imports: a map
 * control is referenced only through the structural {@link GeoLibreControl}
 * type, so the same definitions describe both vanilla and React plugins. The
 * concrete control type is supplied as a generic parameter where it matters.
 */

/** Corner of the map a control can be docked to. */
export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Minimal GeoJSON `FeatureCollection` shape used when a plugin hands the host a
 * dataset to render as a native (MapLibre) layer. Kept structural so this
 * module does not depend on `geojson` types.
 */
export interface GeoLibreFeatureCollection {
  type: "FeatureCollection";
  features: GeoLibreFeature[];
}

/** Minimal GeoJSON `Feature` shape; see {@link GeoLibreFeatureCollection}. */
export interface GeoLibreFeature {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown> | null;
  id?: string | number;
}

/**
 * Visual styling hints for a native layer the host renders on the plugin's
 * behalf. Every field is optional; the host applies sensible defaults for any
 * value the plugin omits.
 */
export interface GeoLibreNativeLayerStyle {
  minZoom?: number;
  maxZoom?: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  circleRadius?: number;
}

/**
 * Registration payload a plugin passes to
 * {@link GeoLibreAppAPI.registerExternalNativeLayer}. It lets GeoLibre own the
 * MapLibre sources and layers (so they appear in the host's layer panel and
 * respect its theme) while the plugin supplies the data and styling.
 */
export interface GeoLibreNativeLayerRegistration {
  /** Stable, plugin-unique id used later to unregister the layer. */
  id: string;
  /** Human-readable name shown in the host's layer list. */
  name: string;
  /** Optional inline data; omit when the host already has the source. */
  geojson?: GeoLibreFeatureCollection;
  /** MapLibre layer ids the host should create or adopt. */
  nativeLayerIds: string[];
  /** MapLibre source ids backing the layers above. */
  sourceIds: string[];
  /** Initial layer opacity in the range 0..1. */
  opacity: number;
  /** Styling hints applied to the rendered layer. */
  style: GeoLibreNativeLayerStyle;
  /** Arbitrary extra data the host may persist or display. */
  metadata?: Record<string, unknown>;
}

/**
 * Registration payload a plugin passes to
 * {@link GeoLibreAppAPI.registerRightPanel}. The host renders a native
 * right-sidebar panel (header with collapse/close buttons, a collapsible rail,
 * and a resize handle) and the plugin owns only the body via {@link render}.
 * While a plugin right panel is the active right-side workspace the host
 * collapses its built-in Style panel and restores it when the plugin panel
 * closes, so the two never compete for space.
 */
export interface GeoLibreRightPanelRegistration {
  /** Stable, plugin-unique id used to open/collapse/close the panel. */
  id: string;
  /** Title shown in the panel header and the collapsed rail. */
  title: string;
  /** Optional rail icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** Preferred expanded width in px (desktop only; the host clamps it). */
  defaultWidth?: number;
  /**
   * Populate the panel body. Called once with an empty container the plugin
   * fills with its own DOM (the contract is plain DOM, not a framework node, so
   * a plugin never has to share the host's UI framework). The container stays
   * mounted across collapse, so plugin DOM state persists. May return a cleanup
   * function the host runs when the panel closes or is unregistered.
   */
  render: (container: HTMLElement) => void | (() => void);
  /** Called after the panel opens (becomes the active workspace). */
  onOpen?: () => void;
  /** Called after the panel collapses to its rail. */
  onCollapse?: () => void;
  /** Called after the panel closes (releases the workspace). */
  onClose?: () => void;
}

/**
 * Structural type for a MapLibre control instance. Using a marker interface
 * keeps this contract independent of the concrete control implementation while
 * still giving the host API a nominal-feeling handle to pass around.
 */
export interface GeoLibreControl {
  onAdd(...args: never[]): HTMLElement;
  onRemove(...args: never[]): void;
}

/**
 * The surface GeoLibre exposes to an active plugin.
 *
 * Only {@link addMapControl} and {@link removeMapControl} are guaranteed. The
 * remaining members are optional host capabilities: always call them with
 * optional chaining (`app.pickLocalDirectoryFiles?.()`) and degrade gracefully
 * when a host build does not provide them.
 *
 * @typeParam TControl - The plugin's concrete control type.
 * @typeParam TMap - The map type {@link getMap} returns. Bind it to your
 *   MapLibre type (`GeoLibreAppAPI<MyControl, maplibregl.Map>`); it defaults to
 *   `unknown` so this contract stays free of MapLibre imports.
 */
export interface GeoLibreAppAPI<
  TControl extends GeoLibreControl = GeoLibreControl,
  TMap = unknown,
> {
  /**
   * Add the plugin's control to the map. Returns `false` when the host refuses
   * (for example, the slot is occupied), in which case the plugin should treat
   * activation as failed.
   */
  addMapControl: (
    control: TControl,
    position?: GeoLibreMapControlPosition,
  ) => boolean;
  /** Remove a previously added control from the map. */
  removeMapControl: (control: TControl) => void;
  /**
   * Open the host's native directory picker and resolve with the selected
   * files, or `null` if the user cancels. Present only on hosts that support
   * local file access (for example, GeoLibre Desktop).
   */
  pickLocalDirectoryFiles?: () => Promise<File[] | null>;
  /**
   * Resolve a fetchable URL for an asset bundled inside this plugin's own
   * folder, given the plugin id and a path relative to its manifest (for
   * example, `"dist/sample-data"`). Use this for assets the plugin ships and
   * loads over HTTP at runtime.
   *
   * Returns `null` when the plugin was not loaded from a URL base (for example,
   * a desktop filesystem install), so the asset is not reachable over HTTP. Call
   * with optional chaining and treat both `undefined` (host lacks the method)
   * and `null` (asset not resolvable) as "this asset is unavailable", hiding any
   * UI that depends on it.
   */
  resolvePluginAssetUrl?: (
    pluginId: string,
    relativePath: string,
  ) => string | null;
  /**
   * Hand the host a dataset to render as a native MapLibre layer it owns. See
   * {@link GeoLibreNativeLayerRegistration}.
   */
  registerExternalNativeLayer?: (
    layer: GeoLibreNativeLayerRegistration,
  ) => void;
  /** Remove a native layer previously registered with the given id. */
  unregisterExternalNativeLayer?: (id: string) => void;
  /**
   * Register a native right-sidebar panel that docks beside the host's built-in
   * Style panel. Returns an unregister function (call it from `deactivate`). The
   * panel is not shown until {@link openRightPanel} is called. Present only on
   * hosts with a right sidebar (for example, GeoLibre Desktop and the web app).
   * See {@link GeoLibreRightPanelRegistration}.
   */
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  /** Remove a previously registered right panel (closing it if active). */
  unregisterRightPanel?: (id: string) => void;
  /**
   * Make the panel the active right-side workspace and expand it. Returns
   * `false` if no panel with that id is registered. Re-opening a collapsed
   * panel expands it.
   */
  openRightPanel?: (id: string) => boolean;
  /** Collapse the active right panel to its rail without closing it. */
  collapseRightPanel?: (id: string) => void;
  /** Close the active right panel and restore the host's Style panel. */
  closeRightPanel?: (id: string) => void;
  /** Id of the active right-side workspace panel, or `null` when none is open. */
  getActiveRightPanel?: () => string | null;
  /**
   * Register a top-level toolbar menu in the host banner, with nested submenus
   * and action items. Returns an unregister function (call it from
   * `deactivate`). Re-registering the same id replaces the menu. See
   * {@link GeoLibreToolbarMenu}.
   */
  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  /** Remove a previously registered toolbar menu. */
  unregisterToolbarMenu?: (id: string) => void;
  /**
   * Register a floating panel: a draggable, closeable card the host overlays on
   * the map's top-left corner. Returns an unregister function (call it from
   * `deactivate`). The panel is not shown until {@link openFloatingPanel} is
   * called. Several floating panels can be open at once and they do not shrink
   * the map. See {@link GeoLibreFloatingPanelRegistration}.
   */
  registerFloatingPanel?: (
    panel: GeoLibreFloatingPanelRegistration,
  ) => () => void;
  /** Remove a registered floating panel (closing it if open). */
  unregisterFloatingPanel?: (id: string) => void;
  /** Open a floating panel (or bring an already-open one to the front). */
  openFloatingPanel?: (id: string) => boolean;
  /** Close an open floating panel. */
  closeFloatingPanel?: (id: string) => void;
  /** Ids of the currently open floating panels, in stacking order. */
  getOpenFloatingPanels?: () => string[];

  // --- Map access -----------------------------------------------------------
  // The members below mirror a subset of GeoLibre's plugin API that data and
  // visualization plugins commonly need. The full, authoritative contract is
  // GeoLibre's `docs/plugin-api.md`; every member here is optional, so call it
  // with optional chaining and degrade when a host build lacks it.

  /**
   * The primary MapLibre map, or `null` when there is none (on the globe, or a
   * non-MapLibre renderer). Prefer {@link getViewBounds} for the viewport,
   * which also works where this returns `null`.
   */
  getMap?: () => TMap | null;
  /** The visible extent as `[west, south, east, north]` in degrees, or `null`. */
  getViewBounds?: () => [number, number, number, number] | null;
  /** The map projection the host keeps (it reverts a raw `map.setProjection`). */
  getMapProjection?: () => "globe" | "mercator";
  /**
   * Set the map projection persistently. deck.gl-backed plugins need
   * `"mercator"`; the globe breaks deck.gl tile traversal.
   */
  setMapProjection?: (projection: "globe" | "mercator") => void;

  // --- Shared libraries: use the host's copy, never bundle your own ----------

  /**
   * GeoLibre's own deck.gl modules. Render deck.gl layers on the host's single
   * instance: deck.gl and luma.gl throw on a second copy and share global
   * singletons, so a bundled copy fails to render. See {@link GeoLibreDeckGL}.
   */
  getDeckGL?: () => Promise<GeoLibreDeckGL>;
  /**
   * GeoLibre's own proj4 module namespace (`default` is the callable library),
   * typed `unknown` here; cast it to `typeof import("proj4")`.
   */
  getProj4?: () => Promise<unknown>;
  /**
   * GeoLibre's own `maplibre-gl-raster` module, for rendering Cloud-Optimized
   * GeoTIFFs on the host's deck.gl. Typed `unknown` here; cast it to
   * `typeof import("maplibre-gl-raster")` (install the package as a dev
   * dependency for its types and import it type-only).
   */
  getMaplibreGlRaster?: () => Promise<unknown>;
  /**
   * GeoLibre's own `maplibre-gl-lidar` module: its loaders decode LAS/LAZ/COPC
   * with the WebAssembly the host serves, and its layers render on the host's
   * deck.gl. Typed `unknown` here; cast it to `typeof import("maplibre-gl-lidar")`
   * (install the package as a dev dependency for its types and import it
   * type-only).
   */
  getMaplibreGlLidar?: () => Promise<unknown>;

  // --- Layers in the host's Layers panel --------------------------------------

  /** Add a GeoJSON layer to the Layers panel. Returns the new layer's id. */
  addGeoJsonLayer?: (name: string, data: GeoLibreFeatureCollection, sourcePath?: string) => string;
  /**
   * Replace a GeoJSON layer's features in place, keeping its style and position.
   * Returns `false` for an unknown, non-GeoJSON, or currently edited layer.
   */
  updateGeoJsonLayer?: (layerId: string, data: GeoLibreFeatureCollection) => boolean;
  /**
   * Add a point cloud (LAS/LAZ/COPC file, or an EPT `ept.json`) as a host LiDAR
   * layer. A URL may be HTTP(S) or `s3://`; a `File` or bytes needs a
   * {@link GeoLibrePointCloudLayerOptions.fileName}. Resolves with the layer id.
   */
  addPointCloudLayer?: (
    source: string | File | ArrayBuffer | Uint8Array,
    options?: GeoLibrePointCloudLayerOptions,
  ) => Promise<string>;
  /** Remove a layer by id; unknown ids are ignored. */
  removeLayer?: (layerId: string) => void;
  /** Show or hide a layer. */
  setLayerVisibility?: (layerId: string, visible: boolean) => void;
  /** Ids of the layers in the Layers panel. */
  getLayers?: () => string[];
  /** Call `callback` with the layer ids whenever they change. Returns an unsubscribe. */
  onLayersChanged?: (callback: (layerIds: string[]) => void) => () => void;

  // --- Time Slider ------------------------------------------------------------

  /**
   * Make a layer the plugin renders itself drivable by the host's Time Slider.
   * Pass `{ bind: true }` to bind it right away and open the slider. Returns an
   * unregister function. See {@link GeoLibreTemporalLayerAdapter}.
   */
  registerTemporalLayer?: (
    layerId: string,
    adapter: GeoLibreTemporalLayerAdapter,
    options?: { bind?: boolean },
  ) => () => void;
  /** Drop a layer's temporal adapter. Removing the layer does this too. */
  unregisterTemporalLayer?: (layerId: string) => void;

  // --- Browser address --------------------------------------------------------

  /**
   * Write this plugin's query parameters to the address bar, so the current
   * state can be shared as a deep link (see {@link GeoLibrePlugin.urlParameterNames}).
   */
  setUrlParameters?: (params: URLSearchParams) => void;
}

/**
 * GeoLibre's own deck.gl modules, resolved by {@link GeoLibreAppAPI.getDeckGL}.
 * Each is typed `unknown` so this contract does not depend on deck.gl; cast to
 * the module you use, e.g. `deck.layers as typeof import("@deck.gl/layers")`,
 * with deck.gl installed as a dev dependency and imported type-only.
 */
export interface GeoLibreDeckGL {
  /** `@deck.gl/core` */
  core: unknown;
  /** `@deck.gl/layers` */
  layers: unknown;
  /** `@deck.gl/aggregation-layers` */
  aggregationLayers: unknown;
  /** `@deck.gl/geo-layers` */
  geoLayers: unknown;
  /** `@deck.gl/mesh-layers` */
  meshLayers: unknown;
  /** `@deck.gl/mapbox` (`MapboxOverlay` for interleaved MapLibre rendering) */
  mapbox: unknown;
}

/** Options for {@link GeoLibreAppAPI.addPointCloudLayer}. */
export interface GeoLibrePointCloudLayerOptions {
  /** Layers panel name (default: the URL's file name, or `fileName`). */
  name?: string;
  /**
   * File name the loader sees for a `File` or bytes; its extension picks the
   * loader (`.las`, `.laz`, `.copc.laz`). Required for bytes.
   */
  fileName?: string;
  /** Fly to the point cloud once it loads (default `true`). */
  zoomTo?: boolean;
}

/** Stepping unit for the Time Slider. */
export type GeoLibreTimeGranularity = "hour" | "day" | "month" | "year";

/**
 * How the Time Slider drives a layer the plugin renders itself, passed to
 * {@link GeoLibreAppAPI.registerTemporalLayer}.
 */
export interface GeoLibreTemporalLayerAdapter {
  /**
   * The layer's time coordinate, in index order: `Date`s, epoch milliseconds
   * or seconds, bare calendar years, or date strings.
   */
  getTimeValues: () => ReadonlyArray<Date | number | string>;
  /** Apply a date to the layer, snapping it to the nearest time value. */
  setTime: (date: Date) => void | Promise<void>;
  /** Name of the dimension being driven, persisted with the project (default `"time"`). */
  dimension?: string;
  /** Stepping unit; derived from the axis span when omitted. */
  granularity?: GeoLibreTimeGranularity;
  /** Units offered by the slider's granularity controls. */
  displayUnits?: GeoLibreTimeGranularity[];
}

/**
 * An action item in a plugin {@link GeoLibreToolbarMenu}. Selecting it runs
 * {@link onSelect} (for example, to open a right panel or floating panel).
 */
export interface GeoLibreToolbarMenuAction {
  /** Discriminator; defaults to "action" when omitted. */
  type?: "action";
  /** Stable id, unique within the menu. */
  id: string;
  /** Label shown in the menu. */
  label: string;
  /** Optional icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** When true, the item is shown disabled and cannot be selected. */
  disabled?: boolean;
  /** Invoked when the user selects the item. */
  onSelect: () => void;
}

/** A nested submenu in a plugin {@link GeoLibreToolbarMenu}. */
export interface GeoLibreToolbarSubmenu {
  type: "submenu";
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
}

/** A divider between groups of items in a plugin toolbar menu. */
export interface GeoLibreToolbarSeparator {
  type: "separator";
  id?: string;
}

/** One entry in a plugin toolbar menu: an action, a submenu, or a separator. */
export type GeoLibreToolbarMenuItem =
  | GeoLibreToolbarMenuAction
  | GeoLibreToolbarSubmenu
  | GeoLibreToolbarSeparator;

/**
 * A plugin-owned top-level toolbar menu. The host renders it as a dropdown
 * button in the banner beside the built-in menus.
 */
export interface GeoLibreToolbarMenu {
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
}

/**
 * A plugin-owned floating panel: a draggable, closeable card the host overlays
 * on the map's top-left corner. The plugin owns only the body via {@link render}
 * (plain DOM); the host provides the card chrome (a draggable title bar with a
 * close button).
 */
export interface GeoLibreFloatingPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  /** Preferred card width in px (the host clamps it). */
  defaultWidth?: number;
  /**
   * Populate the card body. Called once with an empty container the plugin
   * fills with its own DOM. The container stays mounted while the card is open,
   * so plugin state persists. May return a cleanup function the host runs when
   * the panel closes or is unregistered.
   */
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * The object a plugin's GeoLibre entry point must export. GeoLibre calls these
 * members across the plugin lifecycle; everything beyond `id`, `name`,
 * `version`, `activate`, and `deactivate` is optional and only invoked when the
 * plugin declares it.
 *
 * @typeParam TControl - The plugin's concrete control type.
 * @typeParam TMap - The map type `app.getMap()` returns (see {@link GeoLibreAppAPI}).
 */
export interface GeoLibrePlugin<
  TControl extends GeoLibreControl = GeoLibreControl,
  TMap = unknown,
> {
  /** Stable plugin id; must match `plugin.json`'s `id`. */
  id: string;
  /** Display name; must match `plugin.json`'s `name`. */
  name: string;
  /** Semantic version; must match `plugin.json`'s `version`. */
  version: string;
  /**
   * Query-parameter names this plugin owns. When the host opens a URL carrying
   * one of these, it auto-activates the plugin and routes the parameters to
   * {@link handleUrlParameters}.
   */
  urlParameterNames?: string[];
  /**
   * Activate the plugin: create and add the control. Return `false` (or remain
   * unactivated) if the control could not be added. May be async, for example
   * to await a shared-library accessor such as {@link GeoLibreAppAPI.getDeckGL}.
   */
  activate: (app: GeoLibreAppAPI<TControl, TMap>) => boolean | void | Promise<boolean | void>;
  /**
   * Deactivate the plugin: capture any state to restore later, then remove the
   * control.
   */
  deactivate: (app: GeoLibreAppAPI<TControl, TMap>) => void;
  /**
   * Handle deep-link query parameters declared in {@link urlParameterNames}.
   * Dispatched by the host once the plugin is active. May be async.
   */
  handleUrlParameters?: (
    app: GeoLibreAppAPI<TControl, TMap>,
    params: URLSearchParams,
  ) => void | Promise<void>;
  /** Report the control's current dock position (for persistence). */
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  /** Move the control to a new dock position. */
  setMapControlPosition?: (
    app: GeoLibreAppAPI<TControl, TMap>,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  /** Serialize plugin state so the host can save it with the project. */
  getProjectState?: () => unknown;
  /** Restore plugin state previously produced by {@link getProjectState}. */
  applyProjectState?: (
    app: GeoLibreAppAPI<TControl, TMap>,
    state: unknown,
  ) => boolean | void;
}
