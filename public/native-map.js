// QZSS専用の2D地図．基図，警報マスク，震源，ズームをCanvasで描く．
// MapLibre/PMTilesのブラウザ実行コードを読み込まない．
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QzssNativeMap = api.NativeMap; root.QzssNativeMarker = api.NativeMarker; }
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE_SIZE = 512;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const mercator = ([lon, lat]) => [
    (lon + 180) / 360,
    (1 - Math.asinh(Math.tan(clamp(lat, -85.051129, 85.051129) * Math.PI / 180)) / Math.PI) / 2,
  ];
  const lngLat = ([x, y]) => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
  const asLngLat = p => Array.isArray(p) ? p : [p.lng, p.lat];

  class BinaryReader {
    constructor(view, offset = 0) { this.view = view; this.pos = offset; }
    u8() { return this.view.getUint8(this.pos++); }
    u16() { const n = this.view.getUint16(this.pos, true); this.pos += 2; return n; }
    i16() { const n = this.view.getInt16(this.pos, true); this.pos += 2; return n; }
    u32() { const n = this.view.getUint32(this.pos, true); this.pos += 4; return n; }
  }

  class TileStore {
    constructor(buffer) {
      this.view = new DataView(buffer); this.index = new Map(); this.decoded = new Map();
      const r = new BinaryReader(this.view);
      const magic = String.fromCharCode(...Array.from({ length: 5 }, () => r.u8()));
      if (magic !== 'QZVT1') throw new Error('invalid native tile archive');
      const count = r.u16();
      for (let i = 0; i < count; i++) {
        const z = r.u8(); const x = r.u16(); const y = r.u16();
        this.index.set(`${z}/${x}/${y}`, { offset: r.u32(), length: r.u32() });
      }
    }
    tile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      if (this.decoded.has(key)) return this.decoded.get(key);
      const entry = this.index.get(key);
      if (!entry) return null;
      const r = new BinaryReader(this.view, entry.offset);
      const layers = {};
      for (const name of ['AdmArea', 'Cstline', 'AdmBdry']) {
        const extent = r.u16(); const count = r.u16(); const features = [];
        for (let f = 0; f < count; f++) {
          const type = r.u8(); const adminLevel = r.i16(); const pathCount = r.u16();
          const paths = [];
          for (let p = 0; p < pathCount; p++) {
            const points = new Int16Array(r.u16() * 2);
            for (let i = 0; i < points.length; i++) points[i] = r.i16();
            paths.push(points);
          }
          features.push({ type, admin_level: adminLevel, paths, path: null });
        }
        layers[name] = { extent, features };
      }
      if (r.pos !== entry.offset + entry.length) throw new Error(`corrupt native tile ${key}`);
      this.decoded.set(key, layers);
      return layers;
    }
  }

  function tilePath(feature) {
    if (feature.path) return feature.path;
    const p = new Path2D();
    for (const points of feature.paths) {
      if (!points.length) continue;
      p.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) p.lineTo(points[i], points[i + 1]);
      if (feature.type === 3) p.closePath();
    }
    feature.path = p;
    return p;
  }

  function visitCoordinates(geometry, visit) {
    if (!geometry) return;
    const type = geometry.type; const coordinates = geometry.coordinates;
    if (type === 'Point') visit([coordinates]);
    else if (type === 'LineString' || type === 'MultiPoint') visit(coordinates);
    else if (type === 'Polygon' || type === 'MultiLineString') for (const line of coordinates) visit(line);
    else if (type === 'MultiPolygon') for (const polygon of coordinates) for (const ring of polygon) visit(ring);
    else if (type === 'GeometryCollection') for (const child of geometry.geometries) visitCoordinates(child, visit);
  }

  function geoPath(feature) {
    if (feature.__nativePath) return feature.__nativePath;
    const path = new Path2D(); const type = feature.geometry?.type || '';
    feature.__nativeCoordPaths = [];
    visitCoordinates(feature.geometry, coordinates => {
      if (!coordinates.length) return;
      const points = coordinates.map(mercator);
      feature.__nativeCoordPaths.push(points);
      path.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        path.lineTo(points[i][0], points[i][1]);
      }
      if (type.includes('Polygon')) path.closePath();
    });
    feature.__nativePath = path;
    return path;
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]; const b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function pointNearLine(point, line, tolerance) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]; const b = line[i];
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      if (Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) <= tolerance) return true;
    }
    return false;
  }

  function evaluate(expression, properties, zoom) {
    if (!Array.isArray(expression)) return expression;
    const [op, ...args] = expression;
    if (op === 'get') return properties[args[0]];
    if (op === 'literal') return args[0];
    if (op === 'zoom') return zoom;
    if (op === 'in') return evaluate(args[1], properties, zoom)?.includes(evaluate(args[0], properties, zoom)) || false;
    if (op === '!=') return evaluate(args[0], properties, zoom) !== evaluate(args[1], properties, zoom);
    if (op === '==') return evaluate(args[0], properties, zoom) === evaluate(args[1], properties, zoom);
    if (op === 'all') return args.every(arg => evaluate(arg, properties, zoom));
    if (op === 'match') {
      const value = evaluate(args[0], properties, zoom);
      for (let i = 1; i < args.length - 1; i += 2) {
        if (Array.isArray(args[i]) ? args[i].includes(value) : args[i] === value) return evaluate(args[i + 1], properties, zoom);
      }
      return evaluate(args.at(-1), properties, zoom);
    }
    if (op === 'interpolate' && args[0]?.[0] === 'linear') {
      const x = evaluate(args[1], properties, zoom);
      for (let i = 2; i < args.length - 2; i += 2) {
        const a = args[i]; const b = args[i + 2];
        if (x <= b) return args[i + 1] + (args[i + 3] - args[i + 1]) * clamp((x - a) / (b - a), 0, 1);
      }
      return args.at(-1);
    }
    return null;
  }

  function paddingObject(p) { return typeof p === 'number' ? { top: p, bottom: p, left: p, right: p } : { top: 0, bottom: 0, left: 0, right: 0, ...(p || {}) }; }

  class NativeMap {
    constructor(options) {
      this.container = typeof options.container === 'string' ? document.getElementById(options.container) : options.container;
      this.container.style.overflow = 'hidden';
      this.baseCanvas = document.createElement('canvas');
      Object.assign(this.baseCanvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
      this.container.appendChild(this.baseCanvas);
      this.baseCtx = this.baseCanvas.getContext('2d', { alpha: false });
      this.canvas = document.createElement('canvas');
      Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', touchAction: 'none' });
      this.container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.markerPane = document.createElement('div');
      Object.assign(this.markerPane.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
      this.container.appendChild(this.markerPane);
      this.style = options.style; this.sources = new Map();
      this.layers = [...(options.style.layers || [])].map(layer => ({ ...layer, paint: { ...(layer.paint || {}) } }));
      this.images = new Map(); this.handlers = new Map(); this.onceHandlers = new Map();
      this.center = asLngLat(options.center); this.zoom = options.zoom;
      this.minZoom = options.minZoom ?? 0; this.maxZoom = options.maxZoom ?? 20;
      this.interactive = options.interactive !== false;
      this.pendingRender = false; this.baseDirty = true; this.animation = null; this.markers = new Set();
      this.metricsEnabled = new URLSearchParams(location.search).has('mapPerf');
      this.baseFrames = 0; this.overlayFrames = 0;
      this.resize(); this.attachInteractions();
      fetch('./data/native-base-tiles.bin').then(response => {
        if (!response.ok) throw new Error(`native tile load failed: ${response.status}`);
        return response.arrayBuffer();
      }).then(buffer => { this.tiles = new TileStore(buffer); this.requestRender(true); this.emit('load'); })
        .catch(error => { console.error(error); this.emit('error', error); });
    }
    on(event, layerOrHandler, maybeHandler) {
      if (typeof layerOrHandler !== 'function') return this; // layer-specific mouse hover is optional
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event).add(layerOrHandler); return this;
    }
    once(event, handler) {
      if (!this.onceHandlers.has(event)) this.onceHandlers.set(event, new Set());
      this.onceHandlers.get(event).add(handler); return this;
    }
    emit(event, payload = {}) {
      for (const h of this.handlers.get(event) || []) h(payload);
      for (const h of this.onceHandlers.get(event) || []) h(payload);
      this.onceHandlers.delete(event);
    }
    getContainer() { return this.container; }
    getCanvas() { return this.canvas; }
    getZoom() { return this.zoom; }
    getLayer(id) { return this.layers.find(layer => layer.id === id); }
    getSource(id) { return this.sources.get(id); }
    addSource(id, config) {
      const base = id === 'fallback-landmass';
      const source = { ...config, setData: data => { source.data = data; this.requestRender(base); } };
      this.sources.set(id, source); this.requestRender(base); return this;
    }
    isBaseLayer(layer) { return layer?.type === 'background' || !!layer?.['source-layer'] || layer?.id === 'fallback-landmass-fill'; }
    addLayer(layer, before) {
      const target = before ? this.layers.findIndex(l => l.id === before) : -1;
      if (target < 0) this.layers.push(layer); else this.layers.splice(target, 0, layer);
      this.requestRender(this.isBaseLayer(layer)); return this;
    }
    moveLayer(id, before) {
      const index = this.layers.findIndex(l => l.id === id);
      if (index < 0) return this;
      const [layer] = this.layers.splice(index, 1);
      const target = this.layers.findIndex(l => l.id === before);
      if (target < 0) this.layers.push(layer); else this.layers.splice(target, 0, layer);
      this.requestRender(this.isBaseLayer(layer)); return this;
    }
    setFilter(id, filter) { const layer = this.getLayer(id); if (layer) { layer.filter = filter; this.requestRender(this.isBaseLayer(layer)); } return this; }
    setPaintProperty(id, key, value) { const layer = this.getLayer(id); if (layer) { layer.paint[key] = value; this.requestRender(this.isBaseLayer(layer)); } return this; }
    hasImage(id) { return this.images.has(id); }
    addImage(id, image) { this.images.set(id, image); this.requestRender(); return this; }
    resize() {
      const width = Math.max(1, this.container.clientWidth); const height = Math.max(1, this.container.clientHeight);
      this.width = width; this.height = height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.dpr = dpr; this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
      this.baseCanvas.width = this.canvas.width; this.baseCanvas.height = this.canvas.height;
      this.requestRender(true); return this;
    }
    worldSize() { return TILE_SIZE * 2 ** this.zoom; }
    project(point) {
      const [x, y] = mercator(asLngLat(point)); const [cx, cy] = mercator(this.center);
      const size = this.worldSize();
      return { x: this.width / 2 + (x - cx) * size, y: this.height / 2 + (y - cy) * size };
    }
    unproject(point) {
      const p = Array.isArray(point) ? point : [point.x, point.y]; const [cx, cy] = mercator(this.center);
      const size = this.worldSize(); const [lng, lat] = lngLat([cx + (p[0] - this.width / 2) / size, cy + (p[1] - this.height / 2) / size]);
      return { lng, lat };
    }
    cameraForBounds(bounds, options = {}) {
      const a = mercator(asLngLat(bounds[0])); const b = mercator(asLngLat(bounds[1]));
      const pad = paddingObject(options.padding);
      const availableWidth = Math.max(1, this.width - pad.left - pad.right);
      const availableHeight = Math.max(1, this.height - pad.top - pad.bottom);
      const dx = Math.max(1e-9, Math.abs(a[0] - b[0])); const dy = Math.max(1e-9, Math.abs(a[1] - b[1]));
      const zoom = clamp(Math.log2(Math.min(availableWidth / (TILE_SIZE * dx), availableHeight / (TILE_SIZE * dy))),
        this.minZoom, Math.min(this.maxZoom, options.maxZoom ?? this.maxZoom));
      const size = TILE_SIZE * 2 ** zoom;
      const center = lngLat([(a[0] + b[0]) / 2 - (pad.left - pad.right) / (2 * size),
        (a[1] + b[1]) / 2 - (pad.top - pad.bottom) / (2 * size)]);
      return { center, zoom };
    }
    fitBounds(bounds, options = {}) { return this.jumpTo(this.cameraForBounds(bounds, options), options); }
    jumpTo(view, options = {}) {
      if (this.animation) cancelAnimationFrame(this.animation);
      const targetCenter = asLngLat(view.center ?? this.center); const targetZoom = clamp(view.zoom ?? this.zoom, this.minZoom, this.maxZoom);
      const duration = options.duration ?? view.duration ?? 0;
      if (duration > 0) {
        const from = mercator(this.center); const to = mercator(targetCenter); const startZoom = this.zoom;
        const start = performance.now();
        const tick = now => {
          const t = clamp((now - start) / duration, 0, 1); const k = t * t * (3 - 2 * t);
          this.center = lngLat([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]);
          this.zoom = startZoom + (targetZoom - startZoom) * k;
          this.emit('zoom'); this.emit('move'); this.requestRender(true);
          if (t < 1) this.animation = requestAnimationFrame(tick);
          else { this.animation = null; this.emit('zoomend'); }
        };
        this.animation = requestAnimationFrame(tick);
      } else {
        this.center = targetCenter; this.zoom = targetZoom;
        this.emit('zoom'); this.emit('move'); this.requestRender(true); this.emit('zoomend');
      }
      return this;
    }
    requestRender(base = false) {
      if (base) this.baseDirty = true;
      if (this.pendingRender) return;
      this.pendingRender = true;
      requestAnimationFrame(() => { this.pendingRender = false; this.render(); this.emit('idle'); });
    }
    attachInteractions() {
      this.canvas.addEventListener('click', e => {
        if (!this.interactive) return;
        const rect = this.canvas.getBoundingClientRect();
        this.emit('click', { point: { x: e.clientX - rect.left, y: e.clientY - rect.top }, lngLat: this.unproject([e.clientX - rect.left, e.clientY - rect.top]) });
      });
      if (!this.interactive) return;
      const pointers = new Map(); let gesture = null;
      const snapshotGesture = () => {
        const points = [...pointers.values()];
        if (!points.length) { gesture = null; return; }
        const midpoint = points.length === 1 ? points[0]
          : [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
        gesture = { midpoint, center: mercator(this.center), zoom: this.zoom,
          distance: points.length < 2 ? 0 : Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]) };
      };
      this.canvas.addEventListener('pointerdown', e => {
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        this.canvas.setPointerCapture(e.pointerId); snapshotGesture();
      });
      this.canvas.addEventListener('pointermove', e => {
        if (!pointers.has(e.pointerId) || !gesture) return;
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        const points = [...pointers.values()];
        if (points.length === 1) {
          this.center = lngLat([gesture.center[0] - (points[0][0] - gesture.midpoint[0]) / this.worldSize(),
            gesture.center[1] - (points[0][1] - gesture.midpoint[1]) / this.worldSize()]);
        } else {
          const midpoint = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
          const distance = Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]);
          this.zoom = clamp(gesture.zoom + Math.log2(Math.max(1, distance) / Math.max(1, gesture.distance)), this.minZoom, this.maxZoom);
          const oldSize = TILE_SIZE * 2 ** gesture.zoom; const newSize = this.worldSize();
          const anchor = [gesture.center[0] + (gesture.midpoint[0] - this.width / 2) / oldSize,
            gesture.center[1] + (gesture.midpoint[1] - this.height / 2) / oldSize];
          this.center = lngLat([anchor[0] - (midpoint[0] - this.width / 2) / newSize,
            anchor[1] - (midpoint[1] - this.height / 2) / newSize]);
          this.emit('zoom');
        }
        this.emit('move'); this.requestRender(true);
      });
      const release = e => { pointers.delete(e.pointerId); snapshotGesture(); this.emit('zoomend'); };
      this.canvas.addEventListener('pointerup', release);
      this.canvas.addEventListener('pointercancel', release);
      this.canvas.addEventListener('wheel', e => {
        e.preventDefault(); const before = this.unproject([e.offsetX, e.offsetY]);
        this.zoom = clamp(this.zoom - e.deltaY * 0.002, this.minZoom, this.maxZoom);
        const after = this.unproject([e.offsetX, e.offsetY]);
        this.center = [this.center[0] + before.lng - after.lng, this.center[1] + before.lat - after.lat];
        this.emit('zoom'); this.emit('move'); this.requestRender(true); this.emit('zoomend');
      }, { passive: false });
    }
    visibleTiles() {
      const z = clamp(Math.floor(this.zoom), 4, 7); const scale = this.worldSize() / 2 ** z;
      const [cx, cy] = mercator(this.center);
      const left = cx * 2 ** z - this.width / (2 * scale);
      const right = cx * 2 ** z + this.width / (2 * scale);
      const top = cy * 2 ** z - this.height / (2 * scale);
      const bottom = cy * 2 ** z + this.height / (2 * scale);
      const tiles = [];
      for (let x = Math.max(0, Math.floor(left)); x <= Math.min(2 ** z - 1, Math.floor(right)); x++)
        for (let y = Math.max(0, Math.floor(top)); y <= Math.min(2 ** z - 1, Math.floor(bottom)); y++) {
          const tile = this.tiles?.tile(z, x, y);
          if (tile) tiles.push({ x, y, z, tile });
        }
      return tiles;
    }
    drawVectorLayer(layer, tiles) {
      const ctx = this.ctx; const name = layer['source-layer'];
      const color = evaluate(layer.paint[`${layer.type}-color`], {}, this.zoom);
      const opacity = evaluate(layer.paint[`${layer.type}-opacity`], {}, this.zoom) ?? 1;
      const width = evaluate(layer.paint['line-width'], {}, this.zoom) ?? 1;
      const [cx, cy] = mercator(this.center); const size = this.worldSize();
      ctx.save(); ctx.globalAlpha = opacity;
      if (layer.type === 'fill') ctx.fillStyle = color; else { ctx.strokeStyle = color; ctx.lineWidth = width; }
      for (const { x, y, z, tile } of tiles) {
        const source = tile[name]; if (!source) continue;
        const tilePixels = size / 2 ** z;
        ctx.save(); ctx.setTransform(this.dpr * tilePixels / source.extent, 0, 0, this.dpr * tilePixels / source.extent,
          this.dpr * (this.width / 2 + (x / 2 ** z - cx) * size),
          this.dpr * (this.height / 2 + (y / 2 ** z - cy) * size));
        ctx.lineWidth = width * source.extent / tilePixels;
        for (const feature of source.features) {
          if (layer.filter && !evaluate(layer.filter, { admin_level: feature.admin_level }, this.zoom)) continue;
          if (layer.type === 'fill' && feature.type === 3) ctx.fill(tilePath(feature), 'evenodd');
          else if (layer.type === 'line' && feature.type === 2) ctx.stroke(tilePath(feature));
        }
        ctx.restore();
      }
      ctx.restore();
    }
    drawGeoLayer(layer) {
      const source = this.sources.get(layer.source);
      if (!source?.data?.features || (layer.filter?.[0] === 'in' && layer.filter[2]?.[1]?.length === 0)) return;
      const ctx = this.ctx; const [cx, cy] = mercator(this.center); const size = this.worldSize();
      const x = this.width / 2 - cx * size; const y = this.height / 2 - cy * size;
      const opacity = evaluate(layer.paint?.[`${layer.type}-opacity`], {}, this.zoom) ?? 1;
      const lineWidth = evaluate(layer.paint?.['line-width'], {}, this.zoom) ?? 1;
      ctx.save(); ctx.globalAlpha = opacity;
      ctx.setTransform(this.dpr * size, 0, 0, this.dpr * size, this.dpr * x, this.dpr * y);
      ctx.lineWidth = lineWidth / size;
      for (const feature of source.data.features) {
        const props = feature.properties || {};
        if (layer.filter && !evaluate(layer.filter, props, this.zoom)) continue;
        if (layer.type === 'symbol') {
          const image = this.images.get(layer.layout?.['icon-image']);
          if (!image || feature.geometry?.type !== 'Point') continue;
          const point = mercator(feature.geometry.coordinates); const scale = layer.layout?.['icon-size'] ?? 1;
          const element = image.data || image;
          const width = image.width || element.width; const height = image.height || element.height;
          ctx.save(); ctx.translate(point[0], point[1]); ctx.scale(1 / size, 1 / size);
          if (element instanceof HTMLCanvasElement || element instanceof HTMLImageElement) ctx.drawImage(element, -width * scale / 2, -height * scale / 2, width * scale, height * scale);
          else {
            const offscreen = document.createElement('canvas'); offscreen.width = width; offscreen.height = height;
            offscreen.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(element), width, height), 0, 0);
            ctx.drawImage(offscreen, -width * scale / 2, -height * scale / 2, width * scale, height * scale);
          }
          ctx.restore(); continue;
        }
        const color = evaluate(layer.paint?.[`${layer.type}-color`], props, this.zoom);
        if (!color) continue;
        const path = geoPath(feature);
        if (layer.type === 'fill') { ctx.fillStyle = color; ctx.fill(path, 'evenodd'); }
        else if (layer.type === 'line') { ctx.strokeStyle = color; ctx.stroke(path); }
      }
      ctx.restore();
    }
    render() {
      if (!this.ctx || !this.baseCtx) return;
      const started = this.metricsEnabled ? performance.now() : 0;
      const overlayCtx = this.ctx;
      if (this.baseDirty) {
        this.ctx = this.baseCtx;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.ctx.fillStyle = '#646464'; this.ctx.fillRect(0, 0, this.width, this.height);
        const tiles = this.visibleTiles();
        for (const layer of this.layers) {
          if (!this.isBaseLayer(layer)) continue;
          if (layer.minzoom && this.zoom < layer.minzoom) continue;
          if (layer.maxzoom && this.zoom >= layer.maxzoom) continue;
          if (layer.type === 'background') { this.ctx.fillStyle = layer.paint['background-color']; this.ctx.fillRect(0, 0, this.width, this.height); }
          else if (layer['source-layer']) this.drawVectorLayer(layer, tiles);
          else this.drawGeoLayer(layer);
        }
        this.baseDirty = false;
        this.baseFrames++;
      }
      const overlayStarted = this.metricsEnabled ? performance.now() : 0;
      this.ctx = overlayCtx;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.clearRect(0, 0, this.width, this.height);
      for (const layer of this.layers) {
        if (this.isBaseLayer(layer)) continue;
        if (layer.minzoom && this.zoom < layer.minzoom) continue;
        if (layer.maxzoom && this.zoom >= layer.maxzoom) continue;
        this.drawGeoLayer(layer);
      }
      for (const marker of this.markers) marker.update();
      this.overlayFrames++;
      if (this.metricsEnabled) {
        this.canvas.dataset.baseFrames = String(this.baseFrames);
        this.canvas.dataset.overlayFrames = String(this.overlayFrames);
        this.canvas.dataset.totalMs = (performance.now() - started).toFixed(2);
        this.canvas.dataset.overlayMs = (performance.now() - overlayStarted).toFixed(2);
      }
    }
    queryRenderedFeatures(point, options = {}) {
      const p = Array.isArray(point) ? { x: (point[0][0] + point[1][0]) / 2, y: (point[0][1] + point[1][1]) / 2 } : point;
      const [cx, cy] = mercator(this.center); const size = this.worldSize();
      const x = cx + (p.x - this.width / 2) / size; const y = cy + (p.y - this.height / 2) / size;
      const found = [];
      for (const layer of [...this.layers].reverse()) {
        if (options.layers && !options.layers.includes(layer.id)) continue;
        const source = this.sources.get(layer.source);
        if (!source?.data?.features) continue;
        for (const feature of source.data.features) {
          if (layer.filter && !evaluate(layer.filter, feature.properties || {}, this.zoom)) continue;
          let hit = false;
          if (feature.geometry?.type === 'Point') {
            const q = mercator(feature.geometry.coordinates); hit = Math.hypot((q[0] - x) * size, (q[1] - y) * size) < 16;
          } else {
            geoPath(feature);
            if (layer.type === 'fill') {
              for (const ring of feature.__nativeCoordPaths) if (pointInRing([x, y], ring)) hit = !hit;
            } else hit = feature.__nativeCoordPaths.some(line => pointNearLine([x, y], line, 12 / size));
          }
          if (hit) found.push({ ...feature, layer: { id: layer.id } });
        }
      }
      return found;
    }
  }

  class NativeMarker {
    constructor(options) { this.element = options.element; this.map = null; this.position = [0, 0]; }
    setLngLat(position) { this.position = asLngLat(position); this.update(); return this; }
    addTo(map) {
      this.map = map; map.markers.add(this); map.markerPane.appendChild(this.element);
      Object.assign(this.element.style, { position: 'absolute', pointerEvents: 'none', transform: 'translate(-50%, -50%)' });
      this.update(); return this;
    }
    getElement() { return this.element; }
    update() {
      if (!this.map) return;
      const p = this.map.project(this.position); this.element.style.left = `${p.x}px`; this.element.style.top = `${p.y}px`;
    }
    remove() { if (this.map) this.map.markers.delete(this); this.element.remove(); this.map = null; }
  }

  return { NativeMap, NativeMarker, TileStore, mercator, lngLat, evaluate, pointInRing, pointNearLine };
});
