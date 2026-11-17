import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreNativeLayerRegistration } from "../geolibre/host-api";
import {
  granuleBands,
  resolveConceptId,
  searchGranules,
} from "../dswx/cmr";
import {
  colormapForBand,
  priorityColormap,
  priorityExpression,
  supportsPriorityComposite,
} from "../dswx/colormaps";
import { bandRenderDefaults, DSWX_PRODUCTS, getProduct } from "../dswx/products";
import {
  buildTileJsonUrl,
  DEFAULT_TITILER_CMR_ENDPOINT,
  fetchTileJson,
  tileSizeFromTemplate,
} from "../dswx/titiler";
import { groupObservations, observationTemporal } from "../dswx/observations";
import {
  computeWaterTimeSeries,
  HLS_PROFILE,
  seriesProfile,
  type SeriesProfile,
  timeSeriesToCsv,
  filterSeries,
  type WaterAreaPoint,
} from "../dswx/timeseries";
import type { BBox, DswxGranule, Observation } from "../dswx/types";
import { aoiTooLarge, drawPolygon, verticesToFeature, type LonLat } from "./aoiDraw";
import { renderTimeSeriesChart } from "./timeSeriesChart";

/** Footprint overlay layer id (registered with the host). */
const FOOTPRINTS_LAYER = "dswx-granule-footprints";
const HIGHLIGHT_LAYER = "dswx-footprint-highlight";
const AOI_LAYER = "dswx-time-series-aoi";

/** Persisted form state (saved with the GeoLibre project). */
export interface DswxState {
  product: string;
  bbox: string;
  start: string;
  end: string;
  band: string;
}

/** "6 Hour", "3 Day", ... for a grouping window in minutes. */
function compositeLabel(minutes: number): string {
  return minutes % 1440 === 0
    ? `${minutes / 1440} Day`
    : `${+(minutes / 60).toFixed(1)} Hour`;
}

export interface DswxPanelOptions {
  /** Add the footprint/overlay layers and rasters through the host. */
  registerLayer?: (layer: GeoLibreNativeLayerRegistration) => void;
  unregisterLayer?: (id: string) => void;
  fitBounds?: (bounds: BBox) => void;
  /** Current map extent, or null when unavailable. */
  getMapBounds?: () => BBox | null;
  /** Raw MapLibre map for AOI drawing; null/absent disables drawing. */
  getMap?: () => MapLibreMap | null;
  /** Save a text file (CSV export). */
  exportText?: (filename: string, content: string) => void;
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
  private _aoi: ReturnType<typeof verticesToFeature> | null = null;
  private _hasAoiLayer = false;
  private _series: WaterAreaPoint[] = [];
  private _seriesTitle = "";
  private _seriesProfile: SeriesProfile = HLS_PROFILE;
  private _seriesAbort?: AbortController;

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
        <div class="dswx-field"><label>Display Layer</label>
          <select data-k="band"></select></div>
        <div class="dswx-row">
          <button type="button" class="dswx-primary" data-k="display" disabled>Display</button>
          <button type="button" data-k="clear">Clear</button>
        </div>
        <details data-k="tsSection"><summary>Water-area time series</summary>
          <div class="dswx-hint">Draw an area, then chart open and partial water
            (WTR) or confidence classes (CONF) across every observation found by the search. Click to add vertices,
            double-click to finish, Esc to cancel.</div>
          <div class="dswx-field"><label>Band</label>
            <select data-k="seriesBand">
              <option value="WTR">WTR (water classification)</option>
              <option value="CONF">CONF (confidence)</option>
            </select></div>
          <div class="dswx-field"><label>Group observations within</label>
            <select data-k="groupWindow">
              <option value="360">6 hours (as listed)</option>
              <option value="4320">3 days</option>
              <option value="10080">7 days</option>
              <option value="30240">21 days</option>
            </select></div>
          <div class="dswx-row">
            <button type="button" data-k="drawAoi">Draw AOI</button>
            <button type="button" data-k="clearAoi" disabled>Clear AOI</button>
          </div>
          <div class="dswx-row">
            <button type="button" class="dswx-primary" data-k="runSeries" disabled>Run</button>
            <button type="button" data-k="exportSeries" disabled>Export CSV</button>
          </div>
          <div class="dswx-hint" data-k="seriesStatus" role="status"></div>
          <div class="dswx-row">
            <div class="dswx-field"><label>Max masked %</label>
              <input data-k="maxMasked" type="number" min="0" max="100" placeholder="off" /></div>
            <div class="dswx-field"><label>Max no-data %</label>
              <input data-k="maxNoData" type="number" min="0" max="100" placeholder="off" /></div>
          </div>
          <div data-k="chart"></div>
        </details>
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
    this._el.drawAoi.addEventListener("click", () => void this._onDrawAoi());
    this._el.clearAoi.addEventListener("click", () => this._clearAoi());
    for (const k of ["maxMasked", "maxNoData"]) {
      this._el[k].addEventListener("input", () => this._redrawSeries());
    }
    this._el.runSeries.addEventListener("click", () => void this._onRunSeries());
    this._el.exportSeries.addEventListener("click", () => this._onExportSeries());
    if (!this._options.getMap?.()) {
      this._el.drawAoi.setAttribute("disabled", "");
      this._el.seriesStatus.textContent =
        "Drawing needs the MapLibre map renderer.";
    }
  }

  /** Remove the UI and every layer this panel added to the map. */
  teardown(): void {
    this._readForm();
    this._clearDisplayed();
    this._removeFootprints();
    this._seriesAbort?.abort();
    this._clearAoi();
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
  }

  private _writeForm(): void {
    if (!this._root) return;
    const s = this._state;
    for (const key of [
      "product",
      "bbox",
      "start",
      "end",
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
      this._setSeries([]);
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
    const hints = bandRenderDefaults(band);
    // Water classification: remap classes so overlaps resolve by priority
    // (water first) with a `lowest` mosaic. Pixel values on the layer are then
    // priority codes, so the colormap is keyed to them.
    const priority = supportsPriorityComposite(product.shortName, band);
    // The categorical priority colormap replaces any continuous rescale/named map.
    const rescale = priority ? undefined : hints.rescale || product.render.rescale;
    const colormapName = priority
      ? undefined
      : hints.colormapName || product.render.colormapName;
    // A named colormap overrides the categorical class colormap.
    const colormap = colormapName
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
            endpoint: DEFAULT_TITILER_CMR_ENDPOINT,
            conceptId,
            backend: product.render.backend,
            datetime: observationTemporal([obs]),
            bands: band ? [band] : product.render.bands,
            bandsRegex: product.render.bandsRegex,
            rescale,
            colormapName,
            colormap: priority
              ? JSON.stringify(priorityColormap(product.shortName, band))
              : colormap,
            ...(priority
              ? {
                  expression: priorityExpression(product.shortName, band),
                  pixelSelection: "lowest",
                }
              : {}),
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

  // --- Time series ------------------------------------------------------

  private _setSeriesStatus(message: string): void {
    if (this._el.seriesStatus) this._el.seriesStatus.textContent = message;
  }

  private _updateSeriesButtons(): void {
    if (!this._root) return;
    this._el.clearAoi.toggleAttribute("disabled", !this._aoi);
    this._el.runSeries.toggleAttribute(
      "disabled",
      !this._aoi || this._observations.length === 0,
    );
    this._el.exportSeries.toggleAttribute("disabled", this._series.length === 0);
  }

  private _drawAoiPreview(vertices: LonLat[]): void {
    if (this._hasAoiLayer) this._options.unregisterLayer?.(AOI_LAYER);
    this._hasAoiLayer = false;
    if (vertices.length < 2) return;
    // Show a closed polygon once there are 3+ vertices, else just the line.
    const geometry =
      vertices.length >= 3
        ? verticesToFeature(vertices).geometry
        : { type: "LineString", coordinates: vertices };
    this._options.registerLayer?.({
      id: AOI_LAYER,
      name: "DSWx time series AOI",
      type: "geojson",
      source: { type: "geojson" },
      nativeLayerIds: [],
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry, properties: {} }],
      } as never,
      opacity: 1,
      style: {
        fillColor: "#ef4444",
        fillOpacity: 0.1,
        strokeColor: "#ef4444",
        strokeWidth: 2,
      },
      metadata: { sourceKind: "dswx-time-series-aoi" },
    });
    this._hasAoiLayer = true;
  }

  private async _onDrawAoi(): Promise<void> {
    const map = this._options.getMap?.();
    if (!map) return;
    this._clearAoi();
    this._el.drawAoi.setAttribute("disabled", "");
    this._setSeriesStatus("Click the map to add vertices; double-click to finish.");
    const vertices = await drawPolygon(map, {
      onChange: (v) => this._drawAoiPreview(v),
    });
    this._el.drawAoi?.removeAttribute("disabled");
    if (!vertices) {
      this._clearAoi();
      this._setSeriesStatus("AOI cancelled (a polygon needs 3+ vertices).");
      return;
    }
    this._aoi = verticesToFeature(vertices);
    this._drawAoiPreview(vertices);
    this._setSeriesStatus(
      aoiTooLarge(vertices)
        ? "AOI set, but it is large (over ~0.4 x 0.4°). The time series may be slow or time out; draw a smaller area around the water body."
        : "AOI set.",
    );
    this._updateSeriesButtons();
  }

  private _clearAoi(): void {
    if (this._hasAoiLayer) this._options.unregisterLayer?.(AOI_LAYER);
    this._hasAoiLayer = false;
    this._aoi = null;
    this._setSeries([]);
    this._updateSeriesButtons();
  }

  /** A percent input as a 0-1 fraction, or undefined when blank/invalid. */
  private _limit(key: string): number | undefined {
    const raw = this._input(key).value.trim();
    const pct = Number(raw);
    return raw === "" || !Number.isFinite(pct) ? undefined : pct / 100;
  }

  /** The series after the masked / no-data limits are applied. */
  private _filteredSeries(): WaterAreaPoint[] {
    return filterSeries(this._series, {
      maxMasked: this._limit("maxMasked"),
      maxNoData: this._limit("maxNoData"),
    });
  }

  private _setSeries(points: WaterAreaPoint[]): void {
    this._series = points;
    this._redrawSeries();
  }

  private _redrawSeries(): void {
    const points = this._filteredSeries();
    if (this._el.chart) {
      this._el.chart.replaceChildren(
        ...(points.length
          ? [
              renderTimeSeriesChart(
                points,
                (i) => this._selectPointObservations(points[i]),
                this._seriesProfile,
                this._seriesTitle,
              ),
            ]
          : []),
      );
    }
    this._updateSeriesButtons();
  }

  /**
   * Select the list observations behind a chart point: every row sharing a
   * granule with the point's group (several rows when a wider window was used).
   */
  private _selectPointObservations(point: WaterAreaPoint): void {
    const granuleIds = new Set(point.granuleIds ?? []);
    const rows = this._observations.filter(
      (o) =>
        o.id === point.observationId || o.granules.some((g) => granuleIds.has(g.id)),
    );
    if (rows.length === 0) return;
    this._selected.clear();
    for (const o of rows) this._selected.add(o.id);
    this._lastAnchor = this._observations.indexOf(rows[0]);
    this._syncSelection();
    this._el.rows
      .querySelector<HTMLElement>(`tr[data-id="${CSS.escape(rows[0].id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  private async _onRunSeries(): Promise<void> {
    this._readForm();
    const product = getProduct(this._state.product);
    if (!product || !this._aoi || this._observations.length === 0) return;
    // WTR is the product's first band; CONF is found among the granule bands.
    const wantConf = this._input("seriesBand").value === "CONF";
    const confBand = this._observations
      .flatMap((o) => o.granules.flatMap((g) => granuleBands(g).map((b) => b.token)))
      .find((t) => /CONF/i.test(t));
    if (wantConf && !confBand) {
      this._setSeriesStatus("No CONF band in the searched observations.");
      return;
    }
    const band = wantConf ? confBand : product.render.bands?.[0];
    if (!band) {
      this._setSeriesStatus("No water-classification band for this product.");
      return;
    }
    const profile = seriesProfile(product.shortName, band);
    this._seriesAbort?.abort();
    const abort = (this._seriesAbort = new AbortController());
    this._el.runSeries.setAttribute("disabled", "");
    // Regroup the searched granules; the default window reproduces the list.
    const windowMinutes = Number(this._input("groupWindow").value);
    const observations = groupObservations(
      this._observations.flatMap((o) => o.granules),
      windowMinutes,
    );
    const total = observations.length;
    this._setSeriesStatus(`Computing 0/${total}…`);
    try {
      const conceptId =
        this._observations[0].conceptId ??
        (await resolveConceptId(product.shortName));
      const points = await computeWaterTimeSeries({
        endpoint: DEFAULT_TITILER_CMR_ENDPOINT,
        conceptId,
        backend: product.render.backend,
        band,
        profile,
        bandsRegex: product.render.bandsRegex,
        aoi: this._aoi,
        observations,
        signal: abort.signal,
        onProgress: (done, n) => this._setSeriesStatus(`Computing ${done}/${n}…`),
      });
      if (abort.signal.aborted) return;
      this._seriesProfile = profile;
      this._seriesTitle = `${product.shortTitle} ${profile.bandName} Time Series [${compositeLabel(windowMinutes)} Composite]`;
      this._setSeries(points);
      const failed = points.filter((p) => p.error).length;
      this._setSeriesStatus(
        failed
          ? `Done; ${failed} of ${points.length} observation(s) failed.`
          : `Done: ${points.length} observation(s).`,
      );
    } catch (err) {
      this._setSeriesStatus(
        `Time series failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this._updateSeriesButtons();
    }
  }

  private _onExportSeries(): void {
    if (this._series.length === 0) return;
    this._options.exportText?.("dswx-water-area.csv", timeSeriesToCsv(this._filteredSeries(), this._seriesProfile));
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
    this._setSeries([]);
    if (this._el.results) this._el.results.hidden = true;
    this._setStatus("");
  }
}
