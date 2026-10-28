import { DswxPanel, type DswxState } from "./lib/core/DswxPanel";
import type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
} from "./lib/geolibre/host-api";
import type { BBox } from "./lib/dswx/types";
import "./lib/styles/dswx-panel.css";

type AppAPI = GeoLibreAppAPI;

const RIGHT_PANEL_ID = "geolibre-dswx-panel";
const TOOLBAR_MENU_ID = "geolibre-dswx-menu";

let panel: DswxPanel | null = null;
let pendingState: Partial<DswxState> | null = null;
let unregisterRightPanel: (() => void) | null = null;
let disposeToolbarMenu: (() => void) | null = null;

/** Viewport extent, preferring the renderer-neutral host call. */
function readMapBounds(app: AppAPI): BBox | null {
  if (app.getViewBounds) {
    const bounds = app.getViewBounds();
    return bounds ? ([...bounds] as BBox) : null;
  }
  const map = app.getMap?.();
  if (!map) return null;
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

function createPanel(app: AppAPI): DswxPanel {
  const next = new DswxPanel({
    registerLayer: (layer) => app.registerExternalNativeLayer?.(layer),
    unregisterLayer: (id) => app.unregisterExternalNativeLayer?.(id),
    fitBounds: (bounds) => app.fitBounds?.(bounds),
    getMapBounds: () => readMapBounds(app),
    getMap: () => app.getMap?.() ?? null,
    exportText: (filename, content) => app.exportTextFile?.(filename, content),
  });
  if (pendingState) next.setState(pendingState);
  return next;
}

function isDswxState(value: unknown): value is Partial<DswxState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

export const plugin: GeoLibrePlugin = {
  id: "geolibre-dswx",
  name: "DSWx",
  version: "0.1.0",
  activate(app) {
    if (!app.registerRightPanel) return false;
    const current = (panel = panel ?? createPanel(app));
    unregisterRightPanel = app.registerRightPanel({
      id: RIGHT_PANEL_ID,
      title: "DSWx",
      defaultWidth: 340,
      render(container) {
        current.render(container);
        return () => current.teardown();
      },
    });
    app.openRightPanel?.(RIGHT_PANEL_ID);

    disposeToolbarMenu =
      app.registerToolbarMenu?.({
        id: TOOLBAR_MENU_ID,
        label: "DSWx",
        items: [
          {
            id: "open",
            label: "Open DSWx search",
            onSelect: () => app.openRightPanel?.(RIGHT_PANEL_ID),
          },
        ],
      }) ?? null;
  },
  deactivate(app) {
    disposeToolbarMenu?.();
    disposeToolbarMenu = null;
    if (panel) pendingState = panel.getState();
    app.closeRightPanel?.(RIGHT_PANEL_ID);
    unregisterRightPanel?.();
    unregisterRightPanel = null;
    panel = null;
  },
  getProjectState() {
    return panel?.getState() ?? pendingState ?? undefined;
  },
  applyProjectState(_app, state) {
    if (!isDswxState(state)) return false;
    pendingState = state;
    panel?.setState(state);
  },
};

export default plugin;
