import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
import type {
  PluginControlOptions,
  PluginState,
  PluginControlEvent,
  PluginControlEventHandler,
} from './types';
import type { DeepLinkConsumer } from '../utils/deep-link';
import type { GeoLibreNativeLayerRegistration } from '../geolibre/host-api';

/**
 * Default options for the PluginControl.
 *
 * The host-capability callbacks default to safe no-ops so the control works as a
 * standalone MapLibre control. The GeoLibre wrapper (`src/geolibre.ts`) binds
 * them to the real host APIs when the plugin runs inside GeoLibre.
 */
const DEFAULT_OPTIONS: Required<PluginControlOptions> = {
  collapsed: true,
  position: 'top-right',
  title: 'Plugin Control',
  panelWidth: 300,
  className: '',
  pickFiles: () => Promise.resolve(null),
  registerNativeLayer: () => undefined,
  unregisterNativeLayer: () => undefined,
};

/**
 * Event handlers map type
 */
type EventHandlersMap = globalThis.Map<PluginControlEvent, Set<PluginControlEventHandler>>;

/**
 * A template MapLibre GL control that can be customized for various plugin needs.
 *
 * @example
 * ```typescript
 * const control = new PluginControl({
 *   title: 'My Custom Control',
 *   collapsed: false,
 *   panelWidth: 320,
 * });
 * map.addControl(control, 'top-right');
 * ```
 */
export class PluginControl implements IControl, DeepLinkConsumer {
  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _status?: HTMLElement;
  private _options: Required<PluginControlOptions>;
  private _state: PluginState;
  private _eventHandlers: EventHandlersMap = new globalThis.Map();

  // Ids of native layers this control has registered with the host, so they can
  // be unregistered when the control is removed.
  private _registeredNativeLayerIds: string[] = [];

  // Panel positioning handlers
  private _resizeHandler: (() => void) | null = null;
  private _mapResizeHandler: (() => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  /**
   * Creates a new PluginControl instance.
   *
   * @param options - Configuration options for the control
   */
  constructor(options?: Partial<PluginControlOptions>) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._state = {
      collapsed: this._options.collapsed,
      panelWidth: this._options.panelWidth,
      data: {},
    };
  }

  /**
   * Called when the control is added to the map.
   * Implements the IControl interface.
   *
   * @param map - The MapLibre GL map instance
   * @returns The control's container element
   */
  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._container = this._createContainer();
    this._panel = this._createPanel();

    // Append panel to map container for independent positioning (avoids overlap with other controls)
    this._mapContainer.appendChild(this._panel);

    // Setup event listeners for panel positioning and click-outside
    this._setupEventListeners();

    // Set initial panel state
    if (!this._state.collapsed) {
      this._panel.classList.add('expanded');
      // Update position after control is added to DOM
      requestAnimationFrame(() => {
        this._updatePanelPosition();
      });
    }

    return this._container;
  }

  /**
   * Called when the control is removed from the map.
   * Implements the IControl interface.
   */
  onRemove(): void {
    // Remove event listeners
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._mapResizeHandler && this._map) {
      this._map.off('resize', this._mapResizeHandler);
      this._mapResizeHandler = null;
    }
    if (this._clickOutsideHandler) {
      document.removeEventListener('click', this._clickOutsideHandler);
      this._clickOutsideHandler = null;
    }

    // Hand any native layers this control registered back to the host.
    this._clearNativeLayers();

    // Remove panel from map container
    this._panel?.parentNode?.removeChild(this._panel);

    // Remove button container from control stack
    this._container?.parentNode?.removeChild(this._container);

    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._status = undefined;
    this._eventHandlers.clear();
  }

  /**
   * Gets the current state of the control.
   *
   * @returns The current plugin state
   */
  getState(): PluginState {
    return { ...this._state };
  }

  /**
   * Updates the control state.
   *
   * @param newState - Partial state to merge with current state
   */
  setState(newState: Partial<PluginState>): void {
    this._state = { ...this._state, ...newState };
    this._emit('statechange');
  }

  /**
   * Toggles the collapsed state of the control panel.
   */
  toggle(): void {
    this._state.collapsed = !this._state.collapsed;

    if (this._panel) {
      if (this._state.collapsed) {
        this._panel.classList.remove('expanded');
        this._emit('collapse');
      } else {
        this._panel.classList.add('expanded');
        this._updatePanelPosition();
        this._emit('expand');
      }
    }

    this._emit('statechange');
  }

  /**
   * Expands the control panel.
   */
  expand(): void {
    if (this._state.collapsed) {
      this.toggle();
    }
  }

  /**
   * Collapses the control panel.
   */
  collapse(): void {
    if (!this._state.collapsed) {
      this.toggle();
    }
  }

  /**
   * Registers an event handler.
   *
   * @param event - The event type to listen for
   * @param handler - The callback function
   */
  on(event: PluginControlEvent, handler: PluginControlEventHandler): void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - The event type
   * @param handler - The callback function to remove
   */
  off(event: PluginControlEvent, handler: PluginControlEventHandler): void {
    this._eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Gets the map instance.
   *
   * @returns The MapLibre GL map instance or undefined if not added to a map
   */
  getMap(): MapLibreMap | undefined {
    return this._map;
  }

  /**
   * Gets the control container element.
   *
   * @returns The container element or undefined if not added to a map
   */
  getContainer(): HTMLElement | undefined {
    return this._container;
  }

  /**
   * Open the host's directory picker and act on the chosen files.
   *
   * Calls the `pickFiles` option, which the GeoLibre wrapper binds to
   * `app.pickLocalDirectoryFiles`. Outside GeoLibre (or on a host without file
   * access) it resolves to `null`. Replace the body with your own handling of
   * the returned files.
   *
   * @returns The selected files, or `null` if the picker was unavailable or cancelled
   */
  async openFiles(): Promise<File[] | null> {
    try {
      const files = await this._options.pickFiles();
      if (!files || files.length === 0) {
        this._setStatus('No files selected.');
        return files;
      }
      this._setStatus(`Selected ${files.length} file(s).`);
      return files;
    } catch {
      this._setStatus('Unable to open folder.');
      return null;
    }
  }

  /**
   * Load plugin data referenced by a deep link.
   *
   * Satisfies {@link DeepLinkConsumer}: the GeoLibre wrapper routes a
   * `?plugin-data=<value>` URL parameter here. This template implementation just
   * records the value and demonstrates handing a native layer to the host;
   * replace it with your own fetch-and-render logic.
   *
   * @param value - The deep-link value (for example, a dataset URL)
   */
  async loadFromUrl(value: string): Promise<void> {
    this.setState({ data: { ...this._state.data, loadedUrl: value } });
    this._setStatus(`Loaded: ${value}`);

    // Demonstrate handing a dataset to GeoLibre as a native layer it owns.
    this._registerNativeLayer({
      id: 'plugin-template-data',
      name: 'Plugin data',
      nativeLayerIds: ['plugin-template-data-layer'],
      sourceIds: ['plugin-template-data-source'],
      opacity: 1,
      style: { circleRadius: 5, fillColor: '#2f7ed8' },
      metadata: { sourceUrl: value },
    });
  }

  /**
   * Register a native layer with the host, tracking its id so it can be removed
   * when the control is torn down. No-ops outside GeoLibre.
   *
   * @param layer - The native layer registration payload
   */
  private _registerNativeLayer(layer: GeoLibreNativeLayerRegistration): void {
    try {
      this._options.registerNativeLayer(layer);
      if (!this._registeredNativeLayerIds.includes(layer.id)) {
        this._registeredNativeLayerIds.push(layer.id);
      }
    } catch {
      this._setStatus('Failed to register native layer.');
    }
  }

  /**
   * Unregister every native layer this control registered with the host.
   */
  private _clearNativeLayers(): void {
    // Reset bookkeeping up front so internal state stays consistent even if a
    // host callback throws partway through teardown.
    const ids = [...this._registeredNativeLayerIds];
    this._registeredNativeLayerIds = [];
    for (const id of ids) {
      try {
        this._options.unregisterNativeLayer(id);
      } catch {
        // Keep clearing the remaining ids.
      }
    }
  }

  /**
   * Update the status line in the panel, if it is mounted.
   *
   * @param message - The status text to display
   */
  private _setStatus(message: string): void {
    if (this._status) {
      this._status.textContent = message;
    }
  }

  /**
   * Emits an event to all registered handlers.
   *
   * @param event - The event type to emit
   */
  private _emit(event: PluginControlEvent): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const eventData = { type: event, state: this.getState() };
      handlers.forEach((handler) => handler(eventData));
    }
  }

  /**
   * Creates the main container element for the control.
   * Contains a toggle button (29x29) matching navigation control size.
   *
   * @returns The container element
   */
  private _createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = `maplibregl-ctrl maplibregl-ctrl-group plugin-control${
      this._options.className ? ` ${this._options.className}` : ''
    }`;

    // Create toggle button (29x29 to match navigation control)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'plugin-control-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', this._options.title);
    toggleBtn.innerHTML = `
      <span class="plugin-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
      </span>
    `;
    toggleBtn.addEventListener('click', () => this.toggle());

    container.appendChild(toggleBtn);

    return container;
  }

  /**
   * Creates the panel element with header and content areas.
   * Panel is positioned as a dropdown below the toggle button.
   *
   * @returns The panel element
   */
  private _createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'plugin-control-panel';
    panel.style.width = `${this._options.panelWidth}px`;

    // Create header with title and close button
    const header = document.createElement('div');
    header.className = 'plugin-control-header';

    const title = document.createElement('span');
    title.className = 'plugin-control-title';
    title.textContent = this._options.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'plugin-control-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close panel');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.collapse());

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Create content area
    const content = document.createElement('div');
    content.className = 'plugin-control-content';

    const placeholder = document.createElement('p');
    placeholder.className = 'plugin-control-placeholder';
    placeholder.textContent = 'Add your custom plugin content here.';

    // Demonstrate the GeoLibre host callbacks end to end. These buttons drive
    // `openFiles()` and `loadFromUrl()`, which call the host-provided pickers
    // and native-layer registration. Outside GeoLibre they fall back to no-ops.
    const actions = document.createElement('div');
    actions.className = 'plugin-control-actions';

    const openFolderBtn = document.createElement('button');
    openFolderBtn.type = 'button';
    openFolderBtn.className = 'plugin-control-action';
    openFolderBtn.textContent = 'Open folder…';
    openFolderBtn.addEventListener('click', () => {
      void this.openFiles();
    });

    actions.appendChild(openFolderBtn);

    const status = document.createElement('div');
    status.className = 'plugin-control-status';
    status.textContent = '';
    this._status = status;

    content.appendChild(placeholder);
    content.appendChild(actions);
    content.appendChild(status);

    panel.appendChild(header);
    panel.appendChild(content);

    return panel;
  }

  /**
   * Setup event listeners for panel positioning and click-outside behavior.
   */
  private _setupEventListeners(): void {
    // Click outside to close (check both container and panel since they're now separate)
    this._clickOutsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        this._container &&
        this._panel &&
        !this._container.contains(target) &&
        !this._panel.contains(target)
      ) {
        this.collapse();
      }
    };
    document.addEventListener('click', this._clickOutsideHandler);

    // Update panel position on window resize
    this._resizeHandler = () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    };
    window.addEventListener('resize', this._resizeHandler);

    // Update panel position on map resize (e.g., sidebar toggle)
    this._mapResizeHandler = () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    };
    this._map?.on('resize', this._mapResizeHandler);
  }

  /**
   * Detect which corner the control is positioned in.
   *
   * @returns The position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
   */
  private _getControlPosition(): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' {
    const parent = this._container?.parentElement;
    if (!parent) return 'top-right'; // Default

    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';

    return 'top-right'; // Default
  }

  /**
   * Update the panel position based on button location and control corner.
   * Positions the panel next to the button, expanding in the appropriate direction.
   */
  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;

    // Get the toggle button (first child of container)
    const button = this._container.querySelector('.plugin-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();

    // Calculate button position relative to map container
    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;

    const panelGap = 5; // Gap between button and panel

    // Reset all positioning
    this._panel.style.top = '';
    this._panel.style.bottom = '';
    this._panel.style.left = '';
    this._panel.style.right = '';

    switch (position) {
      case 'top-left':
        // Panel expands down and to the right
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;

      case 'top-right':
        // Panel expands down and to the left
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;

      case 'bottom-left':
        // Panel expands up and to the right
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;

      case 'bottom-right':
        // Panel expands up and to the left
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
    }
  }
}
