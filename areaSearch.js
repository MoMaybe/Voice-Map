import { summarizeTranscript } from "./summarizeTranscript.js";
import { getSegmentEndpoints } from "./spatialModel.js";

export function isPointInPolygon(location, polygon) {
	if (!location || polygon.length < 3) return false;

	const { latitude, longitude } = location;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

	let inside = false;
	for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
		const current = polygon[index];
		const previous = polygon[previousIndex];
		const crossProduct = (longitude - current.longitude) * (previous.latitude - current.latitude)
			- (latitude - current.latitude) * (previous.longitude - current.longitude);
		const isOnEdge = Math.abs(crossProduct) < 1e-10
			&& longitude >= Math.min(current.longitude, previous.longitude) - 1e-10
			&& longitude <= Math.max(current.longitude, previous.longitude) + 1e-10
			&& latitude >= Math.min(current.latitude, previous.latitude) - 1e-10
			&& latitude <= Math.max(current.latitude, previous.latitude) + 1e-10;
		if (isOnEdge) return true;

		const crossesLatitude = (current.latitude > latitude) !== (previous.latitude > latitude);
		if (
			crossesLatitude &&
			longitude < (
				(previous.longitude - current.longitude) *
				(latitude - current.latitude) /
				(previous.latitude - current.latitude)
			) + current.longitude
		) {
			inside = !inside;
		}
	}
	return inside;
}

function isPointOnSegment(point, start, end) {
	const crossProduct = (point.longitude - start.longitude) * (end.latitude - start.latitude)
		- (point.latitude - start.latitude) * (end.longitude - start.longitude);
	return Math.abs(crossProduct) < 1e-10
		&& point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10
		&& point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
		&& point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10
		&& point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10;
}

function orientation(first, second, third) {
	return (second.longitude - first.longitude) * (third.latitude - first.latitude)
		- (second.latitude - first.latitude) * (third.longitude - first.longitude);
}

function lineSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
	const firstSideStart = orientation(firstStart, firstEnd, secondStart);
	const firstSideEnd = orientation(firstStart, firstEnd, secondEnd);
	const secondSideStart = orientation(secondStart, secondEnd, firstStart);
	const secondSideEnd = orientation(secondStart, secondEnd, firstEnd);

	if (
		((firstSideStart > 0 && firstSideEnd < 0) || (firstSideStart < 0 && firstSideEnd > 0))
		&& ((secondSideStart > 0 && secondSideEnd < 0) || (secondSideStart < 0 && secondSideEnd > 0))
	) {
		return true;
	}

	return (Math.abs(firstSideStart) < 1e-10 && isPointOnSegment(secondStart, firstStart, firstEnd))
		|| (Math.abs(firstSideEnd) < 1e-10 && isPointOnSegment(secondEnd, firstStart, firstEnd))
		|| (Math.abs(secondSideStart) < 1e-10 && isPointOnSegment(firstStart, secondStart, secondEnd))
		|| (Math.abs(secondSideEnd) < 1e-10 && isPointOnSegment(firstEnd, secondStart, secondEnd));
}

export function doesLineSegmentIntersectPolygon(segment, polygon) {
	const endpoints = getSegmentEndpoints(segment);
	if (!endpoints || polygon.length < 3) return false;
	const { startLocation, endLocation } = endpoints;
	if (
		isPointInPolygon(startLocation, polygon)
		|| isPointInPolygon(endLocation, polygon)
	) {
		return true;
	}

	return polygon.some((current, index) => {
		const next = polygon[(index + 1) % polygon.length];
		return lineSegmentsIntersect(startLocation, endLocation, current, next);
	});
}

export function summarizeAreaSegments(segments) {
	const keywordCounts = new Map();
	segments.forEach((segment) => {
		const keywords = segment.summary?.length
			? segment.summary
			: summarizeTranscript(segment.text);
		const uniqueKeywords = new Set(keywords.map((keyword) => keyword.toLocaleLowerCase()));
		uniqueKeywords.forEach((normalizedKeyword) => {
			const displayKeyword = keywords.find(
				(keyword) => keyword.toLocaleLowerCase() === normalizedKeyword,
			);
			const current = keywordCounts.get(normalizedKeyword);
			keywordCounts.set(normalizedKeyword, {
				keyword: current?.keyword || displayKeyword,
				count: (current?.count || 0) + 1,
			});
		});
	});
	return [...keywordCounts.values()]
		.sort((left, right) => right.count - left.count || left.keyword.localeCompare(right.keyword))
		.slice(0, 12);
}
