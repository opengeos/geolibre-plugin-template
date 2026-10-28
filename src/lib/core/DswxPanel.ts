import type { GeoLibreNativeLayerRegistration } from "../geolibre/host-api";
import {
  granuleBands,
  resolveConceptId,
  searchGranules,
} from "../dswx/cmr";
import { colormapForBand } from "../dswx/colormaps";
import { bandRenderDefaults, DSWX_PRODUCTS, getProduct } from "../dswx/products";
import {
  buildTileJsonUrl,
  DEFAULT_TITILER_CMR_ENDPOINT,
  fetchTileJson,
  tileSizeFromTemplate,
} from "../dswx/titiler";
import { groupObservations, observationTemporal } from "../dswx/observations";
import type { BBox, DswxGranule, Observation } from "../dswx/types";

/** Footprint overlay layer id (registered with the host). */
const FOOTPRINTS_LAYER = "dswx-granule-footprints";
const HIGHLIGHT_LAYER = "dswx-footprint-highlight";

/** Persisted form state (saved with the GeoLibre project). */
export interface DswxState {
  product: string;
  bbox: string;
  start: string;
  end: string;
  band: string;
  rescale: string;
  colormapName: string;
  endpoint: string;
}

export interface DswxPanelOptions {
  /** Add the footprint/overlay layers and rasters through the host. */
  registerLayer?: (layer: GeoLibreNativeLayerRegistration) => void;
  unregisterLayer?: (id: string) => void;
  fitBounds?: (bounds: BBox) => void;
  /** Current map extent, or null when unavailable. */
  getMapBounds?: () => BBox | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultState(): DswxState {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  return {
    product: DSWX_PRODUCTS[0].shortName,
    bbox: "",
    start: isoDay(start),
    end: isoDay(end),
    band: "",
    rescale: "",
    colormapName: "",
    endpoint: "",
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Parse "w,s,e,n" into a valid bbox, or undefined. */
export function parseBBox(text: string): BBox | undefined {
  const parts = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  const [w, s, e, n] = parts;
  if (w >= e || s >= n || s < -90 || n > 90 || w < -180 || e > 180) {
    return undefined;
  }
  return [w, s, e, n];
}

/**
 * Search-and-display UI for DSWx-HLS and DSWx-S1.
 *
 * Plain DOM so it can be mounted in a GeoLibre right panel (or any container).
 * Search uses the public NASA CMR API; rendering goes through titiler-cmr, which
 * handles Earthdata auth server-side, so no login is needed in the browser.
 */
export class DswxPanel {
  private _options: DswxPanelOptions;
  private _state: DswxState = defaultState();
  private _root?: HTMLElement;
  private _observations: Observation[] = [];
  private _selected = new Set<string>();
  private _lastAnchor: number | null = null;
  private _displayed = new Set<string>();
  private _hasFootprints = false;
  private _hasHighlight = false;

  private _el: Record<string, HTMLElement> = {};

  constructor(options: DswxPanelOptions = {}) {
    this._options = options;
  }

  getState(): DswxState {
    this._readForm();
    return { ...this._state };
  }

  setState(state: Partial<DswxState>): void {
    this._state = { ...this._state, ...state };
    this._writeForm();
  }

  /** Mount the UI into `container`. */
  render(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "dswx-panel";
    this._root = root;

    const productOptions = DSWX_PRODUCTS.map(
      (p) => `<option value="${p.shortName}">${p.shortTitle}</option>`,
    ).join("");
    root.innerHTML = `
      <div class="dswx-field"><label>Product</label>
        <select data-k="product">${productOptions}</select>
        <div class="dswx-hint" data-k="productHint"></div></div>
      <div class="dswx-field"><label>Bounding box (W, S, E, N)</label>
        <input data-k="bbox" placeholder="-122.6, 37.2, -121.8, 37.9" />
        <button type="button" data-k="useExtent">Use map extent</button></div>
      <div class="dswx-row">
        <div class="dswx-field"><label>Start</label><input data-k="start" type="date" /></div>
        <div class="dswx-field"><label>End</label><input data-k="end" type="date" /></div>
      </div>
      <button type="button" class="dswx-primary" data-k="search">Search</button>
      <div class="dswx-status" data-k="status" role="status"></div>
      <div class="dswx-results" data-k="results" hidden>
        <div class="dswx-table-wrap"><table><thead><tr>
          <th>Observation (UTC)</th><th>Sensor</th><th>Tiles</th></tr></thead>
          <tbody data-k="rows"></tbody></table></div>
        <div class="dswx-field"><label>Layer</label>
          <select data-k="band"></select></div>
        <details><summary>Rendering</summary>
          <div class="dswx-field"><label>Rescale (min,max)</label>
            <input data-k="rescale" placeholder="auto" /></div>
          <div class="dswx-field"><label>Colormap</label>
            <input data-k="colormapName" placeholder="default" /></div>
          <div class="dswx-field"><label>titiler-cmr endpoint</label>
            <input data-k="endpoint" placeholder="${DEFAULT_TITILER_CMR_ENDPOINT}" /></div>
        </details>
        <div class="dswx-row">
          <button type="button" class="dswx-primary" data-k="display" disabled>Display</button>
          <button type="button" data-k="clear">Clear</button>
        </div>
      </div>`;
    container.appendChild(root);

    root.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => {
      this._el[el.dataset.k!] = el;
    });
    this._writeForm();
    this._updateProductHint();

    this._el.product.addEventListener("change", () => {
      this._readForm();
      this._updateProductHint();
      this._clearResults();
    });
    this._el.useExtent.addEventListener("click", () => this._useExtent());
    this._el.search.addEventListener("click", () => void this._onSearch());
    this._el.display.addEventListener("click", () => void this._onDisplay());
    this._el.clear.addEventListener("click", () => this._clearDisplayed());
    this._el.band.addEventListener("change", () => this._applyBandDefaults());
  }

  /** Remove the UI and every layer this panel added to the map. */
  teardown(): void {
    this._readForm();
    this._clearDisplayed();
    this._removeFootprints();
    this._root?.remove();
    this._root = undefined;
    this._el = {};
  }

  // --- Form -------------------------------------------------------------

  private _input(key: string): HTMLInputElement {
    return this._el[key] as HTMLInputElement;
  }

  private _readForm(): void {
    if (!this._root) return;
    const s = this._state;
    s.product = this._input("product").value;
    s.bbox = this._input("bbox").value.trim();
    s.start = this._input("start").value;
    s.end = this._input("end").value;
    s.band = this._input("band").value || s.band;
    s.rescale = this._input("rescale").value.trim();
    s.colormapName = this._input("colormapName").value.trim();
    s.endpoint = this._input("endpoint").value.trim();
  }

  private _writeForm(): void {
    if (!this._root) return;
    const s = this._state;
    for (const key of [
      "product",
      "bbox",
      "start",
      "end",
      "rescale",
      "colormapName",
      "endpoint",
    ] as const) {
      this._input(key).value = s[key];
    }
  }

  private _updateProductHint(): void {
    const p = getProduct(this._state.product);
    this._el.productHint.textContent = p?.description ?? "";
  }

  private _setStatus(message: string): void {
    if (this._el.status) this._el.status.textContent = message;
  }

  private _useExtent(): void {
    const bounds = this._options.getMapBounds?.();
    if (!bounds) {
      this._setStatus("The map extent is unavailable.");
      return;
    }
    this._input("bbox").value = bounds.map((v) => v.toFixed(4)).join(", ");
    this._readForm();
  }

  // --- Search -----------------------------------------------------------

  private async _onSearch(): Promise<void> {
    this._readForm();
    const { product, bbox: bboxText, start, end } = this._state;
    const bbox = bboxText ? parseBBox(bboxText) : undefined;
    if (bboxText && !bbox) {
      this._setStatus("Bounding box must be W, S, E, N in degrees.");
      return;
    }
    if (start && end && start > end) {
      this._setStatus("Start date is after the end date.");
      return;
    }
    this._el.search.setAttribute("disabled", "");
    this._setStatus("Searching NASA CMR…");
    try {
      const result = await searchGranules({
        shortName: product,
        bbox,
        start: start || undefined,
        end: end || undefined,
        count: 1000,
      });
      this._observations = groupObservations(result.granules);
      this._selected.clear();
      this._lastAnchor = null;
      this._clearHighlight();
      this._renderFootprints(result.featureCollection);
      this._renderRows();
      this._el.results.hidden = this._observations.length === 0;
      this._setStatus(
        this._observations.length
          ? `Found ${this._observations.length} observation(s) from ${result.granules.length} granule(s)${
              result.total > result.granules.length
                ? ` (newest ${result.granules.length} of ${result.total}; narrow the dates or area for the rest)`
                : ""
            }.`
          : "No observations found for that area and date range.",
      );
      if (result.bounds) this._options.fitBounds?.(result.bounds);
    } catch (err) {
      this._setStatus(
        `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this._el.search.removeAttribute("disabled");
    }
  }

  private _renderRows(): void {
    const tbody = this._el.rows;
    tbody.replaceChildren();
    this._observations.forEach((o, index) => {
      const tr = document.createElement("tr");
      tr.dataset.id = o.id;
      const when = document.createElement("td");
      when.textContent = o.start.slice(0, 16).replace("T", " ");
      when.title = o.granules.map((g) => g.id).join("\n");
      const sensor = document.createElement("td");
      sensor.textContent = o.sensor;
      const tiles = document.createElement("td");
      tiles.textContent = String(o.granules.length);
      tiles.title = o.tileIds.join(", ");
      tr.append(when, sensor, tiles);
      tr.addEventListener("click", (e) => this._onRowClick(index, e));
      tbody.appendChild(tr);
    });
    this._syncSelection();
  }

  /** Ctrl/Cmd toggles a row, Shift selects a range, a plain click selects one. */
  private _onRowClick(index: number, e: MouseEvent): void {
    const id = this._observations[index].id;
    if (e.shiftKey && this._lastAnchor !== null) {
      const [a, b] = [this._lastAnchor, index].sort((x, y) => x - y);
      this._selected.clear();
      for (let i = a; i <= b; i++) this._selected.add(this._observations[i].id);
    } else if (e.metaKey || e.ctrlKey) {
      if (!this._selected.delete(id)) this._selected.add(id);
      this._lastAnchor = index;
    } else {
      this._selected.clear();
      this._selected.add(id);
      this._lastAnchor = index;
    }
    this._syncSelection();
  }

  private _selectedObservations(): Observation[] {
    return this._observations.filter((o) => this._selected.has(o.id));
  }

  private _syncSelection(): void {
    this._el.rows.querySelectorAll<HTMLElement>("tr").forEach((tr) => {
      tr.classList.toggle("selected", this._selected.has(tr.dataset.id!));
    });
    const selected = this._selectedObservations();
    const granules = selected.flatMap((o) => o.granules);
    this._el.display.toggleAttribute("disabled", selected.length === 0);
    this._renderBands(granules);
    this._drawHighlight(granules);
  }

  /** Band list: the layers present in every selected granule. */
  private _renderBands(selected: DswxGranule[]): void {
    const select = this._el.band as HTMLSelectElement;
    const product = getProduct(this._state.product);
    let tokens: string[] = [];
    if (selected.length) {
      const lists = selected.map((g) => granuleBands(g).map((b) => b.token));
      tokens = lists[0].filter((t) => lists.every((l) => l.includes(t)));
    }
    const wanted =
      this._state.band || product?.render.bands?.[0] || tokens[0] || "";
    select.replaceChildren(
      ...tokens.map((t) => {
        const opt = document.createElement("option");
        opt.value = opt.textContent = t;
        return opt;
      }),
    );
    if (tokens.includes(wanted)) select.value = wanted;
    this._state.band = select.value;
    this._applyBandDefaults();
  }

  private _applyBandDefaults(): void {
    const band = (this._el.band as HTMLSelectElement).value;
    this._state.band = band;
    const hints = bandRenderDefaults(band);
    this._input("rescale").value = hints.rescale;
    this._input("colormapName").value = hints.colormapName;
  }

  // --- Footprints -------------------------------------------------------

  private _renderFootprints(data: {
    type: "FeatureCollection";
    features: unknown[];
  }): void {
    this._removeFootprints();
    if (!this._options.registerLayer || data.features.length === 0) return;
    this._options.registerLayer({
      id: FOOTPRINTS_LAYER,
      name: "DSWx granule footprints",
      type: "geojson",
      source: { type: "geojson" },
      nativeLayerIds: [],
      geojson: data as never,
      opacity: 1,
      style: {
        fillColor: "#3b82f6",
        fillOpacity: 0.12,
        strokeColor: "#3b82f6",
        strokeWidth: 1,
      },
      metadata: { sourceKind: "dswx-granule-footprints" },
    });
    this._hasFootprints = true;
  }

  private _removeFootprints(): void {
    if (this._hasFootprints) this._options.unregisterLayer?.(FOOTPRINTS_LAYER);
    this._hasFootprints = false;
    this._clearHighlight();
  }

  private _clearHighlight(): void {
    if (this._hasHighlight) this._options.unregisterLayer?.(HIGHLIGHT_LAYER);
    this._hasHighlight = false;
  }

  private _drawHighlight(selected: DswxGranule[]): void {
    this._clearHighlight();
    if (!this._options.registerLayer || selected.length === 0) return;
    this._options.registerLayer({
      id: HIGHLIGHT_LAYER,
      name: "Selected DSWx footprints",
      type: "geojson",
      source: { type: "geojson" },
      nativeLayerIds: [],
      geojson: {
        type: "FeatureCollection",
        features: selected
          .filter((g) => g.geometry)
          .map((g) => ({
            type: "Feature",
            geometry: g.geometry,
            properties: { id: g.id },
          })),
      } as never,
      opacity: 1,
      style: {
        fillColor: "#f59e0b",
        fillOpacity: 0.15,
        strokeColor: "#f59e0b",
        strokeWidth: 2,
      },
      metadata: { sourceKind: "dswx-footprint-highlight" },
    });
    this._hasHighlight = true;
  }

  // --- Display ----------------------------------------------------------

  private async _onDisplay(): Promise<void> {
    this._readForm();
    const product = getProduct(this._state.product);
    const selected = this._selectedObservations();
    if (!product || selected.length === 0) {
      this._setStatus("Select an observation first.");
      return;
    }
    const band = this._state.band || product.render.bands?.[0];
    const rescale = this._state.rescale || product.render.rescale;
    const colormapName = this._state.colormapName || product.render.colormapName;
    // A named colormap overrides the categorical class colormap.
    const colormap = this._state.colormapName
      ? undefined
      : colormapForBand(product.shortName, band);

    this._el.display.setAttribute("disabled", "");
    this._setStatus(`Requesting ${selected.length} observation(s) from titiler-cmr…`);
    try {
      const conceptId =
        selected[0].conceptId ?? (await resolveConceptId(product.shortName));
      let ok = 0;
      // One layer per observation: titiler-cmr mosaics every granule (MGRS
      // tile) inside the observation's time window into a single tileset.
      await Promise.all(
        selected.map(async (obs) => {
          const url = buildTileJsonUrl({
            endpoint: this._state.endpoint || DEFAULT_TITILER_CMR_ENDPOINT,
            conceptId,
            backend: product.render.backend,
            datetime: observationTemporal([obs]),
            bands: band ? [band] : product.render.bands,
            bandsRegex: product.render.bandsRegex,
            rescale,
            colormapName,
            colormap,
          });
          try {
            const tilejson = await fetchTileJson(url);
            const tileUrl = tilejson.tiles[0];
            const id = `dswx-obs-${slug(obs.id)}-${slug(band ?? "band")}`;
            this._options.registerLayer?.({
              id,
              name: `${product.shortTitle} ${band ?? ""} — ${obs.start.slice(0, 16).replace("T", " ")} ${obs.sensor}`.trim(),
              type: "raster",
              source: {
                type: "raster",
                tiles: [tileUrl],
                tileSize: tileSizeFromTemplate(tileUrl),
                ...(tilejson.minzoom != null
                  ? { minzoom: tilejson.minzoom }
                  : {}),
                ...(tilejson.maxzoom != null
                  ? { maxzoom: tilejson.maxzoom }
                  : {}),
              },
              nativeLayerIds: [],
              opacity: 1,
              metadata: {
                sourceKind: "dswx-titiler-cmr",
                observationId: obs.id,
                granuleIds: obs.granules.map((g) => g.id),
              },
            });
            this._displayed.add(id);
            ok++;
          } catch {
            // Report the partial count below.
          }
        }),
      );
      const boxes = selected.map((o) => o.bbox).filter((b): b is BBox => !!b);
      if (boxes.length) {
        this._options.fitBounds?.([
          Math.min(...boxes.map((b) => b[0])),
          Math.min(...boxes.map((b) => b[1])),
          Math.max(...boxes.map((b) => b[2])),
          Math.max(...boxes.map((b) => b[3])),
        ]);
      }
      this._setStatus(
        ok === selected.length
          ? `Displayed ${ok} observation(s).`
          : `Displayed ${ok}/${selected.length} observation(s); the rest failed to load.`,
      );
    } catch (err) {
      this._setStatus(
        `Display failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this._syncSelection();
    }
  }

  private _clearDisplayed(): void {
    for (const id of this._displayed) this._options.unregisterLayer?.(id);
    this._displayed.clear();
    if (this._root) this._setStatus("Cleared displayed layers.");
  }

  private _clearResults(): void {
    this._observations = [];
    this._selected.clear();
    this._removeFootprints();
    if (this._el.results) this._el.results.hidden = true;
    this._setStatus("");
  }
}
