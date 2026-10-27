import assert from "node:assert/strict";
import test from "node:test";
import { sampleSegmentLocations, segmentMatchesSearch } from "./heatmap.js";

const segment = {
	text: "People talked about public parks.",
	summary: ["Parks", "Community"],
	startLocation: { latitude: 47.6, longitude: -122.3 },
	endLocation: { latitude: 47.6002, longitude: -122.2998 },
};

test("matches transcript and keywords case-insensitively", () => {
	assert.equal(segmentMatchesSearch(segment, "PUBLIC"), true);
	assert.equal(segmentMatchesSearch(segment, "comm"), true);
	assert.equal(segmentMatchesSearch(segment, "unrelated"), false);
	assert.equal(segmentMatchesSearch(segment, "  "), false);
});

test("distributes heat samples along the entire line", () => {
	const locations = sampleSegmentLocations(segment, 10);
	assert.ok(locations.length > 2);
	assert.deepEqual(locations[0], segment.startLocation);
	assert.deepEqual(locations.at(-1), segment.endLocation);
	assert.ok(locations.every((location) => (
		location.latitude >= segment.startLocation.latitude
		&& location.latitude <= segment.endLocation.latitude
	)));
});

test("supports a legacy point as a one-location segment", () => {
	const location = { latitude: 47.6, longitude: -122.3 };
	assert.deepEqual(sampleSegmentLocations({ location }), [location, location]);
});

test("samples across the antimeridian and caps long-segment work", () => {
	const crossing = sampleSegmentLocations({
		startLocation: { latitude: 0, longitude: 179.999 },
		endLocation: { latitude: 0, longitude: -179.999 },
	}, 20);
	assert.ok(crossing.length > 2);
	assert.ok(Math.abs(crossing[Math.floor(crossing.length / 2)].longitude) > 179);

	const longSegment = sampleSegmentLocations({
		startLocation: { latitude: 0, longitude: 0 },
		endLocation: { latitude: 10, longitude: 10 },
	}, 0.001);
	assert.equal(longSegment.length, 501);
});

test("rejects invalid sample spacing and skips invalid segments", () => {
	assert.throws(() => sampleSegmentLocations(segment, 0), /positive number/);
	assert.deepEqual(sampleSegmentLocations({ text: "missing coordinates" }), []);
});
