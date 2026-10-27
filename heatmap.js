import { getSegmentEndpoints } from "./spatialModel.js";

const EARTH_RADIUS_METERS = 6_371_008.8;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const MAX_SAMPLES_PER_SEGMENT = 500;

export function segmentMatchesSearch(segment, searchTerm) {
	const query = searchTerm.trim().toLocaleLowerCase();
	if (!query) return false;
	return String(segment.text || "").toLocaleLowerCase().includes(query)
		|| (Array.isArray(segment.summary) && segment.summary.some((keyword) =>
			String(keyword).toLocaleLowerCase().includes(query),
		));
}

function projectLocation(location) {
	const latitude = Math.max(
		-MAX_MERCATOR_LATITUDE,
		Math.min(MAX_MERCATOR_LATITUDE, location.latitude),
	) * Math.PI / 180;
	return {
		x: EARTH_RADIUS_METERS * location.longitude * Math.PI / 180,
		y: EARTH_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + latitude / 2)),
	};
}

function unprojectLocation(point) {
	return {
		latitude: (2 * Math.atan(Math.exp(point.y / EARTH_RADIUS_METERS)) - Math.PI / 2) * 180 / Math.PI,
		longitude: point.x / EARTH_RADIUS_METERS * 180 / Math.PI,
	};
}

export function sampleSegmentLocations(segment, spacingMeters = 20) {
	if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
		throw new Error("Heatmap sample spacing must be a positive number.");
	}
	const endpoints = getSegmentEndpoints(segment);
	if (!endpoints) return [];

	const start = projectLocation(endpoints.startLocation);
	const end = projectLocation(endpoints.endLocation);
	let deltaX = end.x - start.x;
	if (Math.abs(deltaX) > Math.PI * EARTH_RADIUS_METERS) {
		deltaX -= Math.sign(deltaX) * 2 * Math.PI * EARTH_RADIUS_METERS;
	}
	const deltaY = end.y - start.y;
	const distance = Math.hypot(deltaX, deltaY);
	const sampleCount = Math.min(
		MAX_SAMPLES_PER_SEGMENT,
		Math.max(1, Math.ceil(distance / spacingMeters)),
	);

	return Array.from({ length: sampleCount + 1 }, (_, index) => {
		const fraction = index / sampleCount;
		const longitudeMeters = start.x + deltaX * fraction;
		const wrappedX = ((longitudeMeters + Math.PI * EARTH_RADIUS_METERS)
			% (2 * Math.PI * EARTH_RADIUS_METERS)
			+ (2 * Math.PI * EARTH_RADIUS_METERS))
			% (2 * Math.PI * EARTH_RADIUS_METERS)
			- Math.PI * EARTH_RADIUS_METERS;
		if (index === 0) return endpoints.startLocation;
		if (index === sampleCount) return endpoints.endLocation;
		return unprojectLocation({
			x: wrappedX,
			y: start.y + deltaY * fraction,
		});
	});
}

export function createHeatmapLayer(L) {
	return new (L.Layer.extend({
		initialize() {
			this._segments = [];
			this._visible = false;
			this._frame = null;
			this._boundScheduleDraw = this._scheduleDraw.bind(this);
		},

		onAdd(map) {
			this._map = map;
			this._canvas = L.DomUtil.create("canvas", "voice-map-heatmap");
			this._canvas.setAttribute("aria-hidden", "true");
			Object.assign(this._canvas.style, {
				position: "absolute",
				top: "0",
				left: "0",
				zIndex: "450",
				pointerEvents: "none",
			});
			map.getContainer().appendChild(this._canvas);
			map.on("move zoom resize", this._boundScheduleDraw);
			this._draw();
		},

		onRemove(map) {
			map.off("move zoom resize", this._boundScheduleDraw);
			if (this._frame !== null) window.cancelAnimationFrame(this._frame);
			this._canvas?.remove();
			this._canvas = null;
			this._map = null;
		},

		setSegments(segments) {
			this._segments = segments;
			this._scheduleDraw();
		},

		setVisible(visible) {
			this._visible = visible;
			if (this._canvas) this._canvas.hidden = !visible;
			this._scheduleDraw();
		},

		_scheduleDraw() {
			if (!this._map || this._frame !== null) return;
			this._frame = window.requestAnimationFrame(() => {
				this._frame = null;
				this._draw();
			});
		},

		_draw() {
			if (!this._canvas || !this._map) return;
			const container = this._map.getContainer();
			const width = container.clientWidth;
			const height = container.clientHeight;
			const pixelRatio = window.devicePixelRatio || 1;
			this._canvas.width = Math.round(width * pixelRatio);
			this._canvas.height = Math.round(height * pixelRatio);
			this._canvas.style.width = `${width}px`;
			this._canvas.style.height = `${height}px`;
			const context = this._canvas.getContext("2d");
			if (!context) throw new Error("Canvas is unavailable for drawing the heatmap.");
			context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
			context.clearRect(0, 0, width, height);
			if (!this._visible) return;

			const radius = 22;
			this._segments.forEach((segment) => {
				sampleSegmentLocations(segment).forEach((location) => {
					const point = this._map.latLngToContainerPoint([
						location.latitude,
						location.longitude,
					]);
					if (
						point.x < -radius
						|| point.x > width + radius
						|| point.y < -radius
						|| point.y > height + radius
					) {
						return;
					}

					const gradient = context.createRadialGradient(
						point.x, point.y, 0,
						point.x, point.y, radius,
					);
					gradient.addColorStop(0, "rgba(190, 35, 40, 0.42)");
					gradient.addColorStop(0.35, "rgba(231, 112, 42, 0.25)");
					gradient.addColorStop(0.7, "rgba(242, 194, 59, 0.12)");
					gradient.addColorStop(1, "rgba(242, 194, 59, 0)");
					context.fillStyle = gradient;
					context.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
				});
			});
		},
	}))();
}
