import assert from "node:assert/strict";
import test from "node:test";
import {
	doesLineSegmentIntersectPolygon,
	isPointInPolygon,
	summarizeAreaSegments,
} from "./areaSearch.js";

const polygon = [
	{ latitude: 10, longitude: 10 },
	{ latitude: 10, longitude: 20 },
	{ latitude: 20, longitude: 20 },
	{ latitude: 20, longitude: 10 },
];

test("matches points inside and on the boundary of a drawn area", () => {
	assert.equal(isPointInPolygon({ latitude: 15, longitude: 15 }, polygon), true);
	assert.equal(isPointInPolygon({ latitude: 10, longitude: 15 }, polygon), true);
	assert.equal(isPointInPolygon({ latitude: 25, longitude: 15 }, polygon), false);
	assert.equal(isPointInPolygon({ latitude: 15, longitude: 25 }, polygon), false);
});

test("rejects invalid locations and polygons with fewer than three vertices", () => {
	assert.equal(isPointInPolygon({ latitude: 15, longitude: 15 }, polygon.slice(0, 2)), false);
	assert.equal(isPointInPolygon({ latitude: Number.NaN, longitude: 15 }, polygon), false);
	assert.equal(isPointInPolygon(null, polygon), false);
});

test("matches lines inside, crossing, touching, and outside a drawn area", () => {
	assert.equal(doesLineSegmentIntersectPolygon({
		startLocation: { latitude: 12, longitude: 12 },
		endLocation: { latitude: 18, longitude: 18 },
	}, polygon), true);
	assert.equal(doesLineSegmentIntersectPolygon({
		startLocation: { latitude: 15, longitude: 5 },
		endLocation: { latitude: 15, longitude: 25 },
	}, polygon), true);
	assert.equal(doesLineSegmentIntersectPolygon({
		startLocation: { latitude: 10, longitude: 5 },
		endLocation: { latitude: 10, longitude: 12 },
	}, polygon), true);
	assert.equal(doesLineSegmentIntersectPolygon({
		startLocation: { latitude: 5, longitude: 5 },
		endLocation: { latitude: 8, longitude: 8 },
	}, polygon), false);
});

test("supports legacy point locations and rejects invalid line data", () => {
	assert.equal(doesLineSegmentIntersectPolygon({
		location: { latitude: 15, longitude: 15 },
	}, polygon), true);
	assert.equal(doesLineSegmentIntersectPolygon({
		startLocation: { latitude: Number.NaN, longitude: 15 },
		endLocation: { latitude: 15, longitude: 15 },
	}, polygon), false);
	assert.equal(doesLineSegmentIntersectPolygon({
		startLocation: { latitude: 15, longitude: 15 },
		endLocation: { latitude: 15, longitude: 15 },
	}, polygon.slice(0, 2)), false);
});

test("counts a keyword at most once per segment and ranks by segment count", () => {
	const keywords = summarizeAreaSegments([
		{ summary: ["Tree", "tree", "Park"] },
		{ summary: ["tree", "River"] },
		{ summary: ["Park"] },
	]);
	assert.deepEqual(keywords.slice(0, 2), [
		{ keyword: "Park", count: 2 },
		{ keyword: "Tree", count: 2 },
	]);
	assert.deepEqual(keywords.find(({ keyword }) => keyword === "River"), {
		keyword: "River",
		count: 1,
	});
});
