function isValidLocation(location) {
	return location
		&& Number.isFinite(location.latitude)
		&& Number.isFinite(location.longitude)
		&& Math.abs(location.latitude) <= 90
		&& Math.abs(location.longitude) <= 180;
}

export function getSegmentEndpoints(segment) {
	if (
		(segment.startLocation != null && !isValidLocation(segment.startLocation))
		|| (segment.endLocation != null && !isValidLocation(segment.endLocation))
	) {
		return null;
	}
	const legacyLocation = isValidLocation(segment.location) ? segment.location : null;
	let startLocation = isValidLocation(segment.startLocation)
		? segment.startLocation
		: legacyLocation || (isValidLocation(segment.endLocation) ? segment.endLocation : null);
	let endLocation = isValidLocation(segment.endLocation)
		? segment.endLocation
		: legacyLocation || startLocation;

	if (!startLocation && endLocation) startLocation = endLocation;
	if (!endLocation && startLocation) endLocation = startLocation;
	if (!startLocation || !endLocation) return null;

	return { startLocation, endLocation };
}
