import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./app.css";
import AuthPanel from "./AuthPanel.jsx";
import { summarizeJourneyKeywords, summarizeTranscript } from "./summarizeTranscript.js";
import { doesLineSegmentIntersectPolygon, summarizeAreaSegments } from "./areaSearch.js";
import { getSegmentEndpoints } from "./spatialModel.js";
import { createHeatmapLayer, segmentMatchesSearch } from "./heatmap.js";
import {
	deleteStory,
	loadSavedStories,
	renameSavedStory,
	saveStory,
} from "./storyStorage.js";
import { supabase } from "./supabase.js";

// to turn speech into text, samples the device's location, and exports a GeoJSON.
export default function App() {
	// A ref is a small storage box that React keeps between screen updates.
	// Unlike state, changing a ref does not redraw the screen. These refs are
	// useful for browser objects and for checking the latest recording status.
	const recorderRef = useRef(null);
	const authSessionRef = useRef(null);
	// The microphone stream lets us stop the microphone tracks when we're done.
	const streamRef = useRef(null);
	// The speech recognizer is a separate browser feature from audio recording.
	const recognitionRef = useRef(null);
	const recognitionActiveRef = useRef(false);
	const recordingRef = useRef(false);
	const pausedRef = useRef(false);
	const canRestartRecognitionRef = useRef(true);
	const restartTimeoutRef = useRef(null);
	// Network failures can be temporary, so retries wait longer each time.
	const retryNetworkErrorRef = useRef(false);
	const recognitionRetryDelayRef = useRef(1000);
	// The timer creates a new transcript/location section every 30 seconds.
	const locationIntervalRef = useRef(null);
	// A changing ID helps us ignore location results that arrive after Stop.
	const locationRequestIdRef = useRef(0);
	const locationPermissionDeniedRef = useRef(false);
	// The start time is used to calculate which 30-second section owns new words.
	const recordingStartedAtRef = useRef(0);
	const activeElapsedMsRef = useRef(0);
	const activeStartedAtRef = useRef(0);
	// This ref mirrors transcript state so browser callbacks always see its latest value.
	const transcriptSegmentsRef = useRef([]);
	const mapElementRef = useRef(null);
	const mapRef = useRef(null);
	const segmentLayerRef = useRef(null);
	const areaLayerRef = useRef(null);
	const heatmapLayerRef = useRef(null);
	const mapHasCenteredRef = useRef(false);
	const recordingGenerationRef = useRef(0);
	const audioBlobRef = useRef(null);
	const audioBlobPromiseRef = useRef(Promise.resolve(null));
	const storySaveRequestedRef = useRef(false);
	const finalLocationPromiseRef = useRef(Promise.resolve(null));

	// State is information shown on screen. Updating state tells React to redraw
	// the parts of the page that depend on the changed value.
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [status, setStatus] = useState("Ready to record");
	const [authSession, setAuthSession] = useState(null);
	const [authLoaded, setAuthLoaded] = useState(false);
	const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
	const [installMessage, setInstallMessage] = useState("");
	const [isInstalled, setIsInstalled] = useState(() =>
		window.matchMedia?.("(display-mode: standalone)").matches
		|| window.navigator.standalone === true,
	);
	const [isOnline, setIsOnline] = useState(() => navigator.onLine);
	const [transcriptionStatus, setTranscriptionStatus] = useState("");
	const [transcriptSegments, setTranscriptSegments] = useState([]);
	const [transcriptHistory, setTranscriptHistory] = useState([]);
	const [audioUrl, setAudioUrl] = useState("");
	const [storyAudioUrl, setStoryAudioUrl] = useState("");
	const [savingStory, setSavingStory] = useState(false);
	const [selectedSegment, setSelectedSegment] = useState(null);
	const [journeyReady, setJourneyReady] = useState(false);
	const [showStoryPrompt, setShowStoryPrompt] = useState(false);
	const [storySaveError, setStorySaveError] = useState("");
	const [savedStories, setSavedStories] = useState([]);
	const [storiesLoaded, setStoriesLoaded] = useState(false);
	const [storageStatus, setStorageStatus] = useState("");
	const [storiesExpanded, setStoriesExpanded] = useState(false);
	const [activePage, setActivePage] = useState("home");
	const [mapKeywordSearch, setMapKeywordSearch] = useState("");
	const [mapVisualization, setMapVisualization] = useState("segments");
	const [areaDrawing, setAreaDrawing] = useState(false);
	const [areaVertices, setAreaVertices] = useState([]);
	const [selectedStoryId, setSelectedStoryId] = useState(null);
	const [editingStoryId, setEditingStoryId] = useState(null);
	const [storyTitleDraft, setStoryTitleDraft] = useState("");

	const authUserId = authSession?.user?.id;

	useEffect(() => {
		const installMedia = window.matchMedia("(display-mode: standalone)");
		const handleInstallPrompt = (event) => {
			event.preventDefault();
			setDeferredInstallPrompt(event);
		};
		const handleAppInstalled = () => {
			setIsInstalled(true);
			setDeferredInstallPrompt(null);
			setInstallMessage("Voice Map is installed on this device.");
		};
		const updateInstalledState = () => setIsInstalled(installMedia.matches);
		const updateOnlineState = () => setIsOnline(navigator.onLine);

		window.addEventListener("beforeinstallprompt", handleInstallPrompt);
		window.addEventListener("appinstalled", handleAppInstalled);
		window.addEventListener("online", updateOnlineState);
		window.addEventListener("offline", updateOnlineState);
		installMedia.addEventListener("change", updateInstalledState);
		return () => {
			window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
			window.removeEventListener("appinstalled", handleAppInstalled);
			window.removeEventListener("online", updateOnlineState);
			window.removeEventListener("offline", updateOnlineState);
			installMedia.removeEventListener("change", updateInstalledState);
		};
	}, []);

	async function installApp() {
		if (!deferredInstallPrompt) {
			setInstallMessage("Use your browser menu and choose Install app or Add to Home Screen.");
			return;
		}
		try {
			await deferredInstallPrompt.prompt();
			const { outcome } = await deferredInstallPrompt.userChoice;
			setInstallMessage(outcome === "accepted"
				? "Voice Map is being installed."
				: "Installation was canceled.");
			setDeferredInstallPrompt(null);
		} catch (error) {
			console.error("Could not start app installation.", error);
			setInstallMessage(`Could not install Voice Map: ${error.message}`);
		}
	}

	useEffect(() => {
		let active = true;
		const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
			if (!active) return;
			if (authSessionRef.current?.user?.id !== session?.user?.id) {
				setSavedStories([]);
				setSelectedStoryId(null);
				setStoriesLoaded(false);
				mapHasCenteredRef.current = false;
			}
			authSessionRef.current = session;
			setAuthSession(session);
			setAuthLoaded(true);
		});
		supabase.auth.getSession()
			.then(({ data, error }) => {
				if (error) throw error;
				if (!active) return;
				authSessionRef.current = data.session;
				setAuthSession(data.session);
				setAuthLoaded(true);
			})
			.catch((error) => {
				console.error("Could not check the current Supabase session.", error);
				if (!active) return;
				setAuthLoaded(true);
				setStorageStatus(`Could not check sign-in status: ${error.message}`);
			});
		return () => {
			active = false;
			subscription.unsubscribe();
		};
	}, []);

	useEffect(() => {
		if (!authLoaded) return undefined;
		if (!authUserId) {
			setSavedStories([]);
			setStoriesLoaded(true);
			setSelectedStoryId(null);
			setStorageStatus("Sign in to sync your stories. Audio stays on this device.");
			return undefined;
		}

		let active = true;
		setStoriesLoaded(false);
		loadSavedStories(authUserId)
			.then(({ stories, migratedCount, syncError }) => {
				if (!active) return;
				setSavedStories(stories);
				setStoriesLoaded(true);
				if (syncError) {
					setStorageStatus(`Cloud sync failed: ${syncError.message}. Showing locally saved stories.`);
				} else if (migratedCount > 0) {
					setStorageStatus(`${migratedCount} local ${migratedCount === 1 ? "story was" : "stories were"} imported to your account. Audio stays on this device.`);
				} else {
					setStorageStatus("Stories sync to your account. Audio stays on this device.");
				}
			})
			.catch((error) => {
				console.error("Could not load saved recordings.", error);
				if (!active) return;
				setStoriesLoaded(true);
				setStorageStatus(`Could not load saved recordings: ${error.message}`);
			});
		return () => {
			active = false;
		};
	}, [authLoaded, authUserId]);

	const selectedStory = savedStories.find((story) => story.id === selectedStoryId);
	const selectedStoryKeywords = useMemo(
		() => selectedStory
			? summarizeJourneyKeywords(selectedStory.segments.map((segment) => `${segment.text}${segment.interim}`))
			: [],
		[selectedStory],
	);

	const journeySummary = useMemo(
		() => journeyReady
			? summarizeJourneyKeywords([
				...transcriptHistory,
				...transcriptSegments.map((segment) => `${segment.text}${segment.interim}`),
			])
			: [],
		[journeyReady, transcriptHistory, transcriptSegments],
	);

	const mapSegments = useMemo(() => {
		const savedStorySegments = savedStories.flatMap((story) => story.segments.flatMap((segment, index) => {
			const text = `${segment.text}${segment.interim}`.trim();
			const endpoints = getSegmentEndpoints(segment);
			if (!segment.complete || !endpoints) return [];
			const summary = segment.summary || [];
			return [{
				index,
				storyId: story.id,
				storyTitle: story.title,
				text,
				...endpoints,
				summary,
				summaryStatus: segment.summaryStatus || "",
				matchesSearch: segmentMatchesSearch({ text, summary }, mapKeywordSearch),
			}];
		}));
		if (activePage === "map") return savedStorySegments;

		const visibleSegments = activePage === "savedStories" && selectedStory
			? selectedStory.segments
			: transcriptSegments;
		const currentMapSegments = visibleSegments.flatMap((segment, index) => {
			const text = `${segment.text}${segment.interim}`.trim();
			const endpoints = getSegmentEndpoints(segment);
			if (!segment.complete || !endpoints) return [];
			return [{
				index,
				text,
				...endpoints,
				summary: segment.summary || [],
				summaryStatus: segment.summaryStatus || "",
				matchesSearch: false,
			}];
		});
		return activePage === "home"
			? [...savedStorySegments, ...currentMapSegments]
			: currentMapSegments;
	}, [activePage, mapKeywordSearch, savedStories, selectedStory, transcriptSegments]);

	const matchingMapStories = useMemo(() => {
		if (!mapKeywordSearch.trim()) return [];
		return savedStories.filter((story) => story.segments.some((segment) =>
			segment.complete
			&& getSegmentEndpoints(segment)
			&& segmentMatchesSearch({
				text: `${segment.text}${segment.interim}`,
				summary: segment.summary || [],
			}, mapKeywordSearch),
		));
	}, [mapKeywordSearch, savedStories]);
	const matchingMapSegmentCount = useMemo(
		() => mapSegments.filter((segment) => segment.matchesSearch).length,
		[mapSegments],
	);

	const segmentsInArea = useMemo(() => areaVertices.length >= 3
		? mapSegments.filter((segment) => doesLineSegmentIntersectPolygon(segment, areaVertices))
		: [], [areaVertices, mapSegments]);
	const areaKeywords = useMemo(() => summarizeAreaSegments(segmentsInArea), [segmentsInArea]);

	useEffect(() => {
		if (!selectedStory?.audioBlob) {
			setStoryAudioUrl("");
			return undefined;
		}
		const url = URL.createObjectURL(selectedStory.audioBlob);
		setStoryAudioUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [selectedStory]);

useEffect(() => {
		if (!mapElementRef.current || mapRef.current) return undefined;
		const map = L.map(mapElementRef.current, { zoomControl: false }).setView([20, 0], 2);
		L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
			maxZoom: 19,
		}).addTo(map);
		L.control.zoom({ position: "topright" }).addTo(map);
		mapRef.current = map;
		segmentLayerRef.current = L.layerGroup().addTo(map);
		areaLayerRef.current = L.layerGroup().addTo(map);
		heatmapLayerRef.current = createHeatmapLayer(L).addTo(map);

		return () => {
			map.remove();
			mapRef.current = null;
			segmentLayerRef.current = null;
			areaLayerRef.current = null;
			heatmapLayerRef.current = null;
		};
	}, []);

	useEffect(() => {
		const map = mapRef.current;
		if (!map || activePage !== "map") return undefined;
		const handleMapClick = (event) => {
			if (!areaDrawing) return;
			setAreaVertices((vertices) => [
				...vertices,
				{ latitude: event.latlng.lat, longitude: event.latlng.lng },
			]);
		};
		map.on("click", handleMapClick);
		if (areaDrawing) map.doubleClickZoom.disable();
		else map.doubleClickZoom.enable();
		return () => {
			map.off("click", handleMapClick);
			map.doubleClickZoom.enable();
		};
	}, [activePage, areaDrawing]);

	useEffect(() => {
		const areaLayer = areaLayerRef.current;
		if (!areaLayer) return;
		areaLayer.clearLayers();
		if (areaVertices.length > 0) {
			const latLngs = areaVertices.map(({ latitude, longitude }) => [latitude, longitude]);
			if (areaVertices.length >= 3) {
				L.polygon(latLngs, {
					color: "#a34f2d",
					weight: 3,
					fillColor: "#d97745",
					fillOpacity: 0.18,
					interactive: false,
				}).addTo(areaLayer);
			} else {
				L.polyline(latLngs, {
					color: "#a34f2d",
					weight: 3,
					dashArray: "6 6",
					interactive: false,
				}).addTo(areaLayer);
			}
			latLngs.forEach((latLng) => {
				L.circleMarker(latLng, {
					radius: 5,
					color: "#ffffff",
					weight: 2,
					fillColor: "#a34f2d",
					fillOpacity: 1,
					interactive: false,
				}).addTo(areaLayer);
			});
		}
	}, [areaVertices]);

	useEffect(() => {
		const segmentLayer = segmentLayerRef.current;
		const heatmapLayer = heatmapLayerRef.current;
		if (!mapRef.current || !segmentLayer) return;
		const isHeatmapMode = activePage === "map" && mapVisualization === "heatmap";
		heatmapLayer?.setSegments(mapSegments.filter((segment) => segment.matchesSearch));
		heatmapLayer?.setVisible(isHeatmapMode && Boolean(mapKeywordSearch.trim()));
		segmentLayer.clearLayers();
		if (isHeatmapMode) return;
		const isSavedStory = activePage === "savedStories" && Boolean(selectedStory);
		mapSegments.forEach((segment) => {
			const isMapSearch = activePage === "map" && Boolean(mapKeywordSearch.trim());
			const lineColor = isSavedStory
				? "#d97745"
				: isMapSearch
					? segment.matchesSearch ? "#d97745" : "#9ba39d"
					: "#18794e";
			const line = L.polyline(
				[
					[segment.startLocation.latitude, segment.startLocation.longitude],
					[segment.endLocation.latitude, segment.endLocation.longitude],
				],
				{
					color: lineColor,
					weight: segment.matchesSearch || isSavedStory ? 6 : 5,
					opacity: isMapSearch && !segment.matchesSearch ? 0.55 : 0.9,
					lineCap: "round",
					lineJoin: "round",
				},
			).addTo(segmentLayerRef.current);
			const popupContent = document.createElement("div");
			popupContent.className = "transcript-popup";
			const title = document.createElement("strong");
			title.className = "transcript-popup-title";
			title.textContent = `${segment.storyTitle ? `${segment.storyTitle} · ` : ""}Interval ${segment.index + 1} · Main words`;
			popupContent.append(title);
			if (segment.summary.length > 0) {
				const list = document.createElement("ul");
				list.className = "transcript-popup-keywords";
				segment.summary.forEach((summaryPoint) => {
					const item = document.createElement("li");
					item.textContent = summaryPoint;
					list.append(item);
				});
				popupContent.append(list);
			} else {
				const summaryStatus = document.createElement("p");
				summaryStatus.className = "transcript-popup-status";
				summaryStatus.textContent = segment.summaryStatus || (segment.text
					? "No keywords found in this transcript."
					: "No transcript was captured during this interval.");
				popupContent.append(summaryStatus);
			}
			if (segment.text) {
				const fullTranscript = document.createElement("details");
				fullTranscript.className = "transcript-popup-details";
				const detailsLabel = document.createElement("summary");
				detailsLabel.textContent = "View full transcript";
				const transcript = document.createElement("p");
				transcript.className = "transcript-popup-text";
				transcript.textContent = segment.text;
				fullTranscript.append(detailsLabel, transcript);
				popupContent.append(fullTranscript);
			}

			let hovered = false;
			let pinned = false;
			let closeTimeout = null;
			const popup = line.bindPopup(popupContent, {
				autoClose: true,
				closeButton: true,
				closeOnClick: true,
				className: "transcript-map-popup",
				maxWidth: 320,
				offset: [0, -5],
			});
			const cancelClose = () => {
				if (closeTimeout) window.clearTimeout(closeTimeout);
				closeTimeout = null;
			};
			const closeOnPointerLeave = () => {
				cancelClose();
				closeTimeout = window.setTimeout(() => {
					if (!hovered && !pinned) line.closePopup();
				}, 120);
			};
			popupContent.addEventListener("mouseenter", () => {
				hovered = true;
				cancelClose();
			});
			popupContent.addEventListener("mouseleave", () => {
				hovered = false;
				closeOnPointerLeave();
			});

			line.on("mouseover", () => {
				hovered = true;
				cancelClose();
				line.openPopup();
			});
			line.on("mouseout", () => {
				hovered = false;
				closeOnPointerLeave();
			});
			line.on("click", () => {
				pinned = true;
				cancelClose();
				line.openPopup();
				setSelectedSegment(segment);
			});
			popup.on("popupclose", () => {
				pinned = false;
				hovered = false;
				cancelClose();
			});
		});

		const frameSegments = (segments) => {
			const coordinates = segments.flatMap(({ startLocation, endLocation }) => [
				[startLocation.latitude, startLocation.longitude],
				[endLocation.latitude, endLocation.longitude],
			]);
			const [firstCoordinate] = coordinates;
			const hasSpread = coordinates.some(([latitude, longitude]) =>
				latitude !== firstCoordinate[0] || longitude !== firstCoordinate[1],
			);
			if (hasSpread) {
				mapRef.current.fitBounds(coordinates, { padding: [40, 40], maxZoom: 14 });
			} else if (firstCoordinate) {
				mapRef.current.setView(firstCoordinate, 14);
			}
		};
		if (mapSegments.length > 0 && activePage === "map") {
			const matchingSegments = mapSegments.filter((segment) => segment.matchesSearch);
			frameSegments(matchingSegments.length > 0 ? matchingSegments : mapSegments);
			mapHasCenteredRef.current = true;
		} else if (mapSegments.length > 0 && activePage === "savedStories" && selectedStory) {
			frameSegments(mapSegments);
			mapHasCenteredRef.current = true;
		} else if (
			mapSegments.length > 0
			&& activePage === "home"
			&& (journeyReady || !mapHasCenteredRef.current)
		) {
			frameSegments(mapSegments);
			mapHasCenteredRef.current = true;
		} else if (mapSegments.length > 0 && !mapHasCenteredRef.current) {
			const latestSegment = mapSegments[mapSegments.length - 1];
			mapRef.current.setView([
				latestSegment.endLocation.latitude,
				latestSegment.endLocation.longitude,
			], 14);
			mapHasCenteredRef.current = true;
		}
	}, [activePage, journeyReady, mapKeywordSearch, mapSegments, mapVisualization, selectedStory]);

	// This cleanup runs when the screen is removed and when a saved audio URL
	// is replaced. It prevents leftover timers, microphone access, and file URLs.
	useEffect(() => {
		return () => {
			recordingRef.current = false;
			pausedRef.current = false;
			locationRequestIdRef.current += 1;
			if (restartTimeoutRef.current) window.clearTimeout(restartTimeoutRef.current);
			if (locationIntervalRef.current) window.clearTimeout(locationIntervalRef.current);
			if (recognitionActiveRef.current) recognitionRef.current?.stop();
			if (recorderRef.current && recorderRef.current.state !== "inactive") {
				recorderRef.current.stop();
			}
			streamRef.current?.getTracks().forEach((track) => track.stop());
			if (audioUrl) URL.revokeObjectURL(audioUrl);
		};
	}, [audioUrl]);

	function getActiveElapsedMs() {
		return activeElapsedMsRef.current + (
			recordingRef.current && !pausedRef.current
				? Date.now() - activeStartedAtRef.current
				: 0
		);
	}

	// Change one 30-second transcript section without changing the others.
	// "update" is a function that receives the old section and returns its new version.
	function updateTranscriptSegment(index, update) {
		const nextSegments = transcriptSegmentsRef.current.map((segment, segmentIndex) =>
			segmentIndex === index ? update(segment) : segment,
		);
		transcriptSegmentsRef.current = nextSegments;
		setTranscriptSegments(nextSegments);
		return nextSegments[index];
	}

	function requestTranscriptSummary(segmentIndex, text, recordingGeneration) {
		if (recordingGeneration !== recordingGenerationRef.current) return;
		const points = summarizeTranscript(text);
		updateTranscriptSegment(segmentIndex, (segment) => ({
			...segment,
			summarySourceText: text,
			summary: points,
			summaryStatus: "",
		}));
	}

	function finalizeTranscriptSegment(index) {
		const segment = transcriptSegmentsRef.current[index];
		if (!segment) return;
		const text = `${segment.text}${segment.interim}`.trim();
		const completedSegment = updateTranscriptSegment(index, (current) => ({
			...current,
			complete: true,
		}));
		if (text && completedSegment.summarySourceText !== text) {
			requestTranscriptSummary(index, text, recordingGenerationRef.current);
		}
	}

	// Add a blank section for a new 30-second period and return its list position.
	function createTranscriptSegment() {
		if (transcriptSegmentsRef.current.length > 0) {
			finalizeTranscriptSegment(transcriptSegmentsRef.current.length - 1);
		}
		const segment = {
			text: "",
			interim: "",
			complete: false,
			startLocation: null,
			endLocation: null,
			locationStatus: !navigator.geolocation
				? "Location is not supported in this browser."
				: locationPermissionDeniedRef.current
					? "Location permission was denied."
					: "Requesting location...",
		};
		const nextSegments = [...transcriptSegmentsRef.current, segment];
		transcriptSegmentsRef.current = nextSegments;
		setTranscriptSegments(nextSegments);
		return nextSegments.length - 1;
	}

	// Ask the browser for the device's current location and attach the answer
	// (or an error message) to the matching transcript section.
	function updateLocation(segmentIndex, requestId, isIntervalBoundary = false) {
		if (!navigator.geolocation || locationPermissionDeniedRef.current) {
			return;
		}

		navigator.geolocation.getCurrentPosition(
			(position) => {
				// Ignore answers from an older recording, but allow a slow location
				// lookup to finish after Stop so its transcript can still be pinned.
				if (requestId !== locationRequestIdRef.current) return;
				const location = {
					latitude: position.coords.latitude,
					longitude: position.coords.longitude,
				};
				updateTranscriptSegment(segmentIndex, (segment) => ({
					...segment,
					startLocation: location,
					locationStatus: "Interval start location captured.",
				}));
				if (isIntervalBoundary && segmentIndex > 0) {
					updateTranscriptSegment(segmentIndex - 1, (segment) => ({
						...segment,
						endLocation: location,
						locationStatus: "Interval start and end locations captured.",
					}));
				}
			},
			(error) => {
				if (requestId !== locationRequestIdRef.current) return;

				const messages = {
					1: "Location permission was denied.",
					2: "Your current location is unavailable.",
					3: "Getting your location timed out; will try again.",
				};
				// Location errors are kept with the relevant time section too,
				// so the GeoJSON can explain why coordinates are missing.
				updateTranscriptSegment(segmentIndex, (segment) => ({
					...segment,
					locationStatus: messages[error.code] || `Could not get location: ${error.message}`,
				}));

				// A denied permission will not become available by retrying.
				// Keep creating transcript intervals, but stop requesting location.
				if (error.code === 1) {
					locationPermissionDeniedRef.current = true;
				}
			},
			{ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
		);
	}

	function requestEndLocation(segmentIndex, requestId) {
		if (!navigator.geolocation || locationPermissionDeniedRef.current) {
			return Promise.resolve(null);
		}

		return new Promise((resolve) => {
			navigator.geolocation.getCurrentPosition(
				(position) => {
					const location = {
						latitude: position.coords.latitude,
						longitude: position.coords.longitude,
					};
					if (requestId === locationRequestIdRef.current) {
						updateTranscriptSegment(segmentIndex, (segment) => ({
							...segment,
							startLocation: segment.startLocation || location,
							endLocation: location,
							locationStatus: "Interval start and end locations captured.",
						}));
					}
					resolve(location);
				},
				(error) => {
					if (requestId === locationRequestIdRef.current) {
						const messages = {
							1: "Location permission was denied.",
							2: "Your current location is unavailable.",
							3: "Could not capture the interval end location before timeout.",
						};
						updateTranscriptSegment(segmentIndex, (segment) => ({
							...segment,
							locationStatus: messages[error.code] || `Could not get location: ${error.message}`,
						}));
						if (error.code === 1) locationPermissionDeniedRef.current = true;
					}
					resolve(null);
				},
				{ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
			);
		});
	}

	// Get location immediately, then create a fresh transcript/location section
	// every 30 seconds for as long as recording continues.
	function startLocationUpdates() {
		const requestId = locationRequestIdRef.current;
		const firstSegmentIndex = transcriptSegmentsRef.current.length - 1;
		updateLocation(firstSegmentIndex, requestId);
		scheduleNextLocationUpdate(requestId);
	}

	function scheduleNextLocationUpdate(requestId) {
		const elapsedSegmentIndex = Math.floor(getActiveElapsedMs() / 30000);
		while (transcriptSegmentsRef.current.length <= elapsedSegmentIndex) {
			const segmentIndex = createTranscriptSegment();
			updateLocation(segmentIndex, requestId, true);
		}
		const elapsedInSegment = getActiveElapsedMs() % 30000;
		const remainingMs = 30000 - elapsedInSegment;
		locationIntervalRef.current = window.setTimeout(() => {
			if (!recordingRef.current || pausedRef.current) return;
			const segmentIndex = createTranscriptSegment();
			updateLocation(segmentIndex, requestId);
			scheduleNextLocationUpdate(requestId);
		}, remainingMs);
	}

	// Turn all transcript sections into a downloadable GeoJSON file.
	function downloadTranscriptGeoJson() {
		const elapsedSeconds = Math.max(0, Math.ceil(getActiveElapsedMs() / 1000));
		const featureCollection = {
			type: "FeatureCollection",
			features: transcriptSegmentsRef.current.map((segment, index) => {
				const transcriptText = `${segment.text}${segment.interim}`.trim();
				const endpoints = getSegmentEndpoints(segment);
				return {
					type: "Feature",
					geometry: endpoints
						? {
							type: "LineString",
							coordinates: [
								[endpoints.startLocation.longitude, endpoints.startLocation.latitude],
								[endpoints.endLocation.longitude, endpoints.endLocation.latitude],
							],
						}
						: null,
					properties: {
						recording_started_at: new Date(recordingStartedAtRef.current).toISOString(),
						interval_start_seconds: index * 30,
						interval_end_seconds: Math.min((index + 1) * 30, elapsedSeconds),
						transcript: transcriptText,
						location_status: segment.locationStatus,
						start_latitude: endpoints?.startLocation.latitude ?? null,
						start_longitude: endpoints?.startLocation.longitude ?? null,
						end_latitude: endpoints?.endLocation.latitude ?? null,
						end_longitude: endpoints?.endLocation.longitude ?? null,
						keywords: segment.summary || summarizeTranscript(transcriptText),
					},
				};
			}),
		};
		const geoJson = JSON.stringify(featureCollection, null, 2);
		const fileUrl = URL.createObjectURL(new Blob([geoJson], { type: "application/geo+json;charset=utf-8" }));
		const link = document.createElement("a");
		const fileTimestamp = new Date(recordingStartedAtRef.current)
			.toISOString()
			.replaceAll(":", "-");
		link.href = fileUrl;
		link.download = `transcript-${fileTimestamp}.geojson`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
	}

	function downloadSavedStoriesGeoJson() {
		const featureCollection = {
			type: "FeatureCollection",
			features: savedStories.flatMap((story) =>
				story.segments.flatMap((segment, index) => {
					const text = `${segment.text}${segment.interim}`.trim();
					const endpoints = getSegmentEndpoints(segment);
					if (!segment.complete || !endpoints) return [];
					return [{
						type: "Feature",
						geometry: {
							type: "LineString",
							coordinates: [
								[endpoints.startLocation.longitude, endpoints.startLocation.latitude],
								[endpoints.endLocation.longitude, endpoints.endLocation.latitude],
							],
						},
						properties: {
							recording_id: story.id,
							recording_title: story.title,
							recording_started_at: story.recordingStartedAt,
							interval_start_seconds: index * 30,
							interval_end_seconds: Math.min((index + 1) * 30, story.durationSeconds),
							transcript: text,
							start_latitude: endpoints.startLocation.latitude,
							start_longitude: endpoints.startLocation.longitude,
							end_latitude: endpoints.endLocation.latitude,
							end_longitude: endpoints.endLocation.longitude,
							keywords: segment.summary || summarizeTranscript(text),
						},
					}];
				}),
			),
		};
		const geoJson = JSON.stringify(featureCollection, null, 2);
		const fileUrl = URL.createObjectURL(new Blob([geoJson], { type: "application/geo+json;charset=utf-8" }));
		const link = document.createElement("a");
		link.href = fileUrl;
		link.download = "voice-map-saved-recordings.geojson";
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
	}

	function downloadAreaGeoJson() {
		if (areaVertices.length < 3) return;
		const polygonCoordinates = areaVertices.map(({ latitude, longitude }) => [longitude, latitude]);
		polygonCoordinates.push(polygonCoordinates[0]);
		const featureCollection = {
			type: "FeatureCollection",
			features: [
				{
					type: "Feature",
					geometry: { type: "Polygon", coordinates: [polygonCoordinates] },
					properties: {
						type: "selected_area",
						matching_segment_count: segmentsInArea.length,
						keywords: areaKeywords,
					},
				},
				...segmentsInArea.map((segment) => ({
					type: "Feature",
					geometry: {
						type: "LineString",
						coordinates: [
							[segment.startLocation.longitude, segment.startLocation.latitude],
							[segment.endLocation.longitude, segment.endLocation.latitude],
						],
					},
					properties: {
						recording_id: segment.storyId,
						recording_title: segment.storyTitle,
						interval_number: segment.index + 1,
						transcript: segment.text,
						keywords: segment.summary.length
							? segment.summary
							: summarizeTranscript(segment.text),
					},
				})),
			],
		};
		const fileUrl = URL.createObjectURL(new Blob(
			[JSON.stringify(featureCollection, null, 2)],
			{ type: "application/geo+json;charset=utf-8" },
		));
		const link = document.createElement("a");
		link.href = fileUrl;
		link.download = "voice-map-area-search.geojson";
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
	}

	function startAreaDrawing() {
		setAreaVertices([]);
		setAreaDrawing(true);
	}

	function clearArea() {
		setAreaVertices([]);
		setAreaDrawing(false);
	}

	// Start the browser's speech-to-text feature. This is different from saving
	// audio: browser support and internet/service availability can vary.
	function startTranscription() {
		// SpeechRecognition is still a vendor-prefixed, not universally
		// supported browser API, so check both common names before using it.
		const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SpeechRecognition) {
			setTranscriptionStatus("Live transcription is not supported in this browser.");
			return;
		}

		const recognition = new SpeechRecognition();
		const recordingGeneration = recordingGenerationRef.current;
		// Continuous mode asks the browser to keep listening; interim results
		// let the UI show tentative words before they are finalized.
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.onresult = (event) => {
			if (
				recordingGeneration !== recordingGenerationRef.current ||
				recognitionRef.current !== recognition
			) return;
			// Receiving speech means the service is working again; use the
			// shortest delay if another network interruption happens later.
			retryNetworkErrorRef.current = false;
			recognitionRetryDelayRef.current = 1000;
			setTranscriptionStatus("Listening for speech...");
			const elapsedSegmentIndex = Math.floor(
				getActiveElapsedMs() / 30000,
			);
			// For example, 65 seconds after starting belongs to section 2:
			// 0-29 seconds is section 0, 30-59 is section 1, and so on.
			// If the browser delays its interval timer (for example, in a
			// background tab), keep speech in the latest segment already created.
			const segmentIndex = Math.min(
				elapsedSegmentIndex,
				transcriptSegmentsRef.current.length - 1,
			);
			let finalText = "";
			let nextInterim = "";
			// The event can contain several results. Keep finalized words in a
			// persistent transcript segment and replace its interim text with the newest draft.
			for (let index = event.resultIndex; index < event.results.length; index += 1) {
				const result = event.results[index];
				if (result.isFinal) {
					// Final words are kept permanently in this section.
					finalText += result[0].transcript;
				} else {
					// Interim words are a temporary best guess and may change.
					nextInterim += result[0].transcript;
				}
			}
			const updatedSegment = updateTranscriptSegment(segmentIndex, (segment) => ({
				...segment,
				text: segment.text + finalText,
				interim: nextInterim,
			}));
			const updatedText = `${updatedSegment.text}${updatedSegment.interim}`.trim();
			if (
				updatedSegment.complete &&
				updatedText &&
				updatedSegment.summarySourceText !== updatedText
			) {
				requestTranscriptSummary(segmentIndex, updatedText, recordingGeneration);
			}
		};
		recognition.onerror = (event) => {
			if (recognitionRef.current !== recognition) return;
			recognitionActiveRef.current = false;
			// A no-speech result is usually just a pause, not a fatal error.
			if (event.error === "no-speech") {
				setTranscriptionStatus("No speech detected; continuing to listen...");
				return;
			}
			// Browser speech services can temporarily lose their connection.
			// Keep the recognizer eligible for restart when its end event fires.
			if (event.error === "network") {
				// The "end" event below will use this flag to schedule a retry.
				retryNetworkErrorRef.current = true;
				setTranscriptionStatus("Network error; retrying transcription...");
				return;
			}
			canRestartRecognitionRef.current = false;
			// Give common browser/API errors a useful message; preserve the
			// actual error name in the fallback so failures aren't hidden.
			const messages = {
				"not-allowed": "Microphone access for transcription was denied.",
				"service-not-allowed": "The browser's transcription service is unavailable.",
				"audio-capture": "No microphone was available for transcription.",
			};
			setTranscriptionStatus(
				messages[event.error] || `Transcription stopped: ${event.error}.`,
			);
		};
		recognition.onend = () => { 
			if (recognitionRef.current !== recognition) return;
			recognitionActiveRef.current = false;
			// Some browsers end recognition after a pause. Restart only while
			// the recorder is still active and no unrecoverable error occurred.
			if (!recordingRef.current || pausedRef.current || !canRestartRecognitionRef.current) return;
			const retryDelay = retryNetworkErrorRef.current
				? recognitionRetryDelayRef.current
				: 250;
			if (retryNetworkErrorRef.current) {
				// Back off up to 30 seconds when the speech service keeps failing,
				// rather than repeatedly retrying rapidly.
				recognitionRetryDelayRef.current = Math.min(retryDelay * 2, 30000);
				retryNetworkErrorRef.current = false;
			}
			restartTimeoutRef.current = window.setTimeout(() => {
				// The user may have stopped or replaced this recognizer during
				// the short delay, so verify it is still the active instance.
				if (!recordingRef.current || pausedRef.current || recognitionRef.current !== recognition) return;
				try {
					// Restart this recognizer after a browser pause or a retry delay.
					recognition.start();
					recognitionActiveRef.current = true;
					setTranscriptionStatus("Listening for speech...");
				} catch {
					setTranscriptionStatus("Could not restart live transcription.");
					canRestartRecognitionRef.current = false;
				}
			}, retryDelay);
		};

		recognitionRef.current = recognition;
		canRestartRecognitionRef.current = true;
		// Start can throw (for example, if recognition is already running).
		try {
			recognition.start();
			recognitionActiveRef.current = true;
			setTranscriptionStatus("Listening for speech...");
		} catch {
			recognitionRef.current = null;
			setTranscriptionStatus("Could not start live transcription.");
			canRestartRecognitionRef.current = false;
		}
	}

	async function startRecording() {
		// MediaRecorder and getUserMedia are needed for saving the audio itself.
		if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
			setStatus("Audio recording is not supported in this browser.");
			return;
		}

		try {
			// Request microphone access and create a recorder for the granted stream.
			// The browser displays a permission prompt if microphone access is new.
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const recorder = new MediaRecorder(stream);
			// MediaRecorder emits the recording in chunks; combine them once
			// recording ends to make one playable audio Blob.
			const chunks = [];
			let resolveAudioBlob;
			audioBlobPromiseRef.current = new Promise((resolve) => {
				resolveAudioBlob = resolve;
			});

			streamRef.current = stream;
			recorderRef.current = recorder;
			recorder.addEventListener("dataavailable", (event) => {
				// The browser delivers audio in pieces; keep each non-empty piece.
				if (event.data.size > 0) chunks.push(event.data);
			});
			recorder.addEventListener("stop", async () => {
				// Combine the audio pieces into one playable recording.
				const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
				audioBlobRef.current = blob;
				resolveAudioBlob(blob);
				if (!storySaveRequestedRef.current) {
					setAudioUrl((previousUrl) => {
						// Free the previous playback URL before replacing it.
						if (previousUrl) URL.revokeObjectURL(previousUrl);
						return URL.createObjectURL(blob);
					});
				}
				stream.getTracks().forEach((track) => track.stop());
				streamRef.current = null;
				recorderRef.current = null;
				// The recognizer stops separately; clear its references after
				// the audio recorder has completed.
				recognitionRef.current = null;
				recognitionActiveRef.current = false;
				try {
					// Stopping also creates the GeoJSON download.
					if (!storySaveRequestedRef.current) {
						await finalLocationPromiseRef.current;
					}
					if (!storySaveRequestedRef.current) downloadTranscriptGeoJson();
					if (!storySaveRequestedRef.current) {
						setStatus("Recording and transcript GeoJSON saved. Play the audio below.");
					}
				} catch (error) {
					console.error("Could not download the transcript GeoJSON.", error);
					setStatus("Recording saved, but the transcript GeoJSON could not be downloaded.");
				}
			});

			// Start audio capture first, then initialize speech recognition.
			recorder.start();
			audioBlobRef.current = null;
			storySaveRequestedRef.current = false;
			recordingRef.current = true;
			pausedRef.current = false;
			recordingGenerationRef.current += 1;
			recognitionRetryDelayRef.current = 1000;
			retryNetworkErrorRef.current = false;
			setRecording(true);
			setPaused(false);
			if (transcriptSegmentsRef.current.length > 0) {
				setTranscriptHistory((history) => [
					...history,
					...transcriptSegmentsRef.current.map(
						(segment) => `${segment.text}${segment.interim}`,
					),
				]);
			}
			// Keep the live transcript and map scoped to this recording.
			transcriptSegmentsRef.current = [];
			setTranscriptSegments([]);
			setSelectedSegment(null);
			setSelectedStoryId(null);
			setActivePage("home");
			setJourneyReady(false);
			setShowStoryPrompt(false);
			mapHasCenteredRef.current = false;
			recordingStartedAtRef.current = Date.now();
			activeElapsedMsRef.current = 0;
			activeStartedAtRef.current = recordingStartedAtRef.current;
			locationPermissionDeniedRef.current = false;
			finalLocationPromiseRef.current = Promise.resolve(null);
			createTranscriptSegment();
			// New location callbacks use this ID; Stop changes it to invalidate them.
			locationRequestIdRef.current += 1;
			setStatus("Recording...");
			startTranscription();
			startLocationUpdates();
		} catch {
			setStatus("Could not access the microphone. Check your browser permissions.");
		}
	}

	function pauseRecording() {
		if (recorderRef.current?.state !== "recording") return;

		try {
			recorderRef.current.pause();
		} catch (error) {
			console.error("Could not pause the audio recording.", error);
			setStatus("Could not pause recording. You can keep recording or stop.");
			return;
		}

		activeElapsedMsRef.current = getActiveElapsedMs();
		pausedRef.current = true;
		setPaused(true);
		setStatus("Recording paused");
		if (restartTimeoutRef.current) {
			window.clearTimeout(restartTimeoutRef.current);
			restartTimeoutRef.current = null;
		}
		if (locationIntervalRef.current) {
			window.clearTimeout(locationIntervalRef.current);
			locationIntervalRef.current = null;
		}
		if (recognitionActiveRef.current && recognitionRef.current) {
			const recognition = recognitionRef.current;
			recognitionActiveRef.current = false;
			try {
				recognition.stop();
			} catch (error) {
				console.error("Could not pause live transcription.", error);
				setTranscriptionStatus("Recording paused; live transcription could not be paused cleanly.");
			}
		}
		if (transcriptionStatus === "Listening for speech...") {
			setTranscriptionStatus("Transcription paused.");
		}
	}

	function resumeRecording() {
		if (recorderRef.current?.state !== "paused") return;

		try {
			recorderRef.current.resume();
		} catch (error) {
			console.error("Could not resume the audio recording.", error);
			setStatus("Could not resume recording. Try again or stop.");
			return;
		}

		activeStartedAtRef.current = Date.now();
		pausedRef.current = false;
		setPaused(false);
		setStatus("Recording...");
		startTranscription();
		scheduleNextLocationUpdate(locationRequestIdRef.current);
	}

	function stopRecording() {
		// Clear the restart flag/timer first so an ended recognition session
		// cannot start itself again after the user presses Stop.
		activeElapsedMsRef.current = getActiveElapsedMs();
		recordingRef.current = false;
		pausedRef.current = false;
		setPaused(false);
		if (restartTimeoutRef.current) window.clearTimeout(restartTimeoutRef.current);
		if (locationIntervalRef.current) {
			window.clearTimeout(locationIntervalRef.current);
			locationIntervalRef.current = null;
		}
		if (recognitionActiveRef.current && recognitionRef.current) {
			recognitionRef.current.stop();
		}
		recognitionRef.current = null;
		recognitionActiveRef.current = false;
		const lastSegmentIndex = transcriptSegmentsRef.current.length - 1;
		finalLocationPromiseRef.current = requestEndLocation(
			lastSegmentIndex,
			locationRequestIdRef.current,
		);
		finalizeTranscriptSegment(lastSegmentIndex);
		setJourneyReady(true);
		if (recorderRef.current && recorderRef.current.state !== "inactive") {
			// Stopping the recorder triggers its "stop" event, which assembles
			// the audio Blob and makes it available for playback.
			recorderRef.current.stop();
			setRecording(false);
			setTranscriptionStatus((current) =>
				current === "Listening for speech..." ? "Transcription stopped." : current,
			);
		}
		setShowStoryPrompt(true);
	}

	async function addStoryToMap() {
		setStorySaveError("");
		if (!authUserId) {
			setStorySaveError("Sign in before saving a recording to your account.");
			const emailField = document.getElementById("account-email");
			emailField?.scrollIntoView({ behavior: "smooth", block: "center" });
			emailField?.focus({ preventScroll: true });
			return;
		}
		setSavingStory(true);
		try {
			await finalLocationPromiseRef.current;
			const audioBlob = audioBlobRef.current || await audioBlobPromiseRef.current;
			const segments = transcriptSegmentsRef.current.map((segment) => ({ ...segment }));
			const text = segments
				.map((segment) => `${segment.text}${segment.interim}`.trim())
				.filter(Boolean)
				.join("\n\n");
			const storyNumber = savedStories.length + 1;
			const storyNumberWords = [
				"One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
				"Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
				"Eighteen", "Nineteen", "Twenty",
			];
			const id = `${Date.now()}-${storyNumber}`;
			const story = {
				id,
				title: `Story ${storyNumberWords[storyNumber - 1] || storyNumber}`,
				text,
				segments,
				audioBlob,
				recordingStartedAt: new Date(recordingStartedAtRef.current).toISOString(),
				durationSeconds: Math.max(0, Math.ceil(activeElapsedMsRef.current / 1000)),
			};
			storySaveRequestedRef.current = true;
			await saveStory(story, authUserId);
			setSavedStories((stories) => [...stories, { ...story, cloudStored: true }]);
			setSelectedStoryId(story.id);
			setActivePage("savedStories");
			transcriptSegmentsRef.current = [];
			setTranscriptSegments([]);
			setTranscriptHistory([]);
			setJourneyReady(false);
			setSelectedSegment(null);
			setTranscriptionStatus("");
			setAudioUrl("");
			setStatus("Story saved to your account. Audio stays on this device.");
			setStorageStatus("Story and transcript saved to your account; audio stays on this device.");
			setShowStoryPrompt(false);
		} catch (error) {
			console.error("Could not save the recording.", error);
			setStorySaveError(`Could not save this recording: ${error.message}`);
			setStorageStatus(`Could not save this recording: ${error.message}`);
			setStatus("Could not save the recording to your account.");
		} finally {
			setSavingStory(false);
		}
	}

	async function renameStory(event) {
		event.preventDefault();
		const title = storyTitleDraft.trim();
		if (!title) return;
		const story = savedStories.find((savedStory) => savedStory.id === editingStoryId);
		if (!story) return;
		const renamedStory = { ...story, title };
		try {
			await renameSavedStory(story.id, title, authUserId);
			setSavedStories((stories) => stories.map((savedStory) =>
				savedStory.id === editingStoryId ? renamedStory : savedStory,
			));
			setEditingStoryId(null);
			setStoryTitleDraft("");
			setStorageStatus("Story name updated in your account.");
		} catch (error) {
			console.error("Could not rename the saved recording.", error);
			setStorageStatus(`Could not update the story name: ${error.message}`);
		}
	}

	async function deleteSavedStory(story) {
		if (!window.confirm(`Delete "${story.title}" and its saved audio from this device? This cannot be undone.`)) return;
		try {
			await deleteStory(story.id, authUserId);
			setSavedStories((stories) => stories.filter((savedStory) => savedStory.id !== story.id));
			if (selectedStoryId === story.id) setSelectedStoryId(null);
			setStorageStatus("Recording and transcript deleted from your account and this device.");
		} catch (error) {
			console.error("Could not delete the saved recording.", error);
			setStorageStatus(`Could not delete the recording: ${error.message}`);
		}
	}

	function discardRecording() {
		storySaveRequestedRef.current = true;
		setShowStoryPrompt(false);
		setJourneyReady(false);
		setSelectedSegment(null);
		transcriptSegmentsRef.current = [];
		setTranscriptSegments([]);
		setTranscriptHistory([]);
		setAudioUrl("");
		audioBlobRef.current = null;
		setStatus("Recording discarded.");
	}

	function closeStoryDetails() {
		setSelectedStoryId(null);
	}

	function openSavedStory(storyId) {
		setSelectedStoryId(storyId);
		setActivePage("savedStories");
	}

	return (
		<div className="app-shell">
			<aside className="app-sidebar">
				<div className="sidebar-brand">
					<div style={styles.brandMark} aria-hidden="true">◎</div>
					<div>
						<p style={styles.eyebrow}>FIELD NOTES</p>
						<p className="sidebar-title">Voice map</p>
					</div>
				</div>
				<AuthPanel session={authSession} loading={!authLoaded} />
				{!isInstalled && (
					<section className="pwa-install-panel" aria-label="Install Voice Map">
						<button type="button" onClick={installApp}>
							Install Voice Map
						</button>
						{installMessage && <p role="status">{installMessage}</p>}
					</section>
				)}
				{!isOnline && (
					<p className="pwa-offline-notice" role="status">
						Offline: the app shell and on-device audio remain available. Sign-in, cloud sync, and live map tiles need internet.
					</p>
				)}
				<nav className="sidebar-navigation" aria-label="Main navigation">
					<button
						type="button"
						className={`sidebar-button${activePage === "home" ? " is-active" : ""}`}
						aria-current={activePage === "home" ? "page" : undefined}
						onClick={() => setActivePage("home")}
					>
						Home
					</button>
					<button
						type="button"
						className={`sidebar-button${activePage === "map" ? " is-active" : ""}`}
						aria-current={activePage === "map" ? "page" : undefined}
						onClick={() => {
							setSelectedStoryId(null);
							setActivePage("map");
						}}
					>
						Map
					</button>
					<button
						type="button"
						className={`sidebar-button${activePage === "savedStories" ? " is-active" : ""}`}
						aria-current={activePage === "savedStories" ? "page" : undefined}
						onClick={() => setActivePage("savedStories")}
					>
						Saved Stories
					</button>
				</nav>
				<p className="sidebar-storage-status" role="status">
					{storiesLoaded ? storageStatus : "Loading locally saved recordings…"}
				</p>
				{activePage === "map" && (
					<section className="sidebar-map-search" aria-labelledby="map-search-heading">
						<h2 id="map-search-heading">Search map keywords</h2>
						<section className="sidebar-area-search" aria-labelledby="area-search-heading">
							<h3 id="area-search-heading">Explore an area</h3>
							{areaDrawing ? (
								<>
									<p>Click the map to add corners. Add at least 3 points, then finish.</p>
									<p className="sidebar-area-vertex-count">{areaVertices.length} corners added</p>
									<div className="sidebar-area-actions">
										<button
											type="button"
											onClick={() => setAreaDrawing(false)}
											disabled={areaVertices.length < 3}
										>
											Finish area
										</button>
										<button type="button" onClick={clearArea}>Cancel</button>
									</div>
								</>
							) : areaVertices.length >= 3 ? (
								<>
									<p className="sidebar-area-result-count">
										{segmentsInArea.length} transcript {segmentsInArea.length === 1 ? "line segment intersects" : "line segments intersect"} this area
									</p>
									{areaKeywords.length > 0 ? (
										<ul className="sidebar-area-keywords">
											{areaKeywords.map(({ keyword, count }) => (
												<li key={keyword}>
													<span>{keyword}</span>
													<span>{count}</span>
												</li>
											))}
										</ul>
									) : (
										<p>No keywords found for transcript segments in this area.</p>
									)}
									<div className="sidebar-area-actions">
										<button type="button" onClick={downloadAreaGeoJson}>Export area GeoJSON</button>
										<button type="button" onClick={clearArea}>Clear area</button>
									</div>
								</>
							) : (
								<>
									<p>Draw a polygon to find transcript lines that cross or lie inside it.</p>
									<button
										type="button"
										className="sidebar-area-primary"
										onClick={startAreaDrawing}
									>
										Draw an area
									</button>
								</>
							)}
						</section>
						<button
							type="button"
							className="sidebar-map-export"
							onClick={downloadSavedStoriesGeoJson}
							disabled={savedStories.length === 0}
						>
							Export all saved line segments as GeoJSON
						</button>
						<label htmlFor="map-keyword-search">Search transcripts and keywords in saved stories</label>
						<input
							id="map-keyword-search"
							type="search"
							value={mapKeywordSearch}
							onChange={(event) => setMapKeywordSearch(event.target.value)}
							placeholder="Search transcripts or keywords…"
						/>
						<div className="sidebar-map-visualization" role="group" aria-label="Map search display">
							<button
								type="button"
								aria-pressed={mapVisualization === "segments"}
								className={mapVisualization === "segments" ? "is-active" : ""}
								onClick={() => setMapVisualization("segments")}
							>
								Segments
							</button>
							<button
								type="button"
								aria-pressed={mapVisualization === "heatmap"}
								className={mapVisualization === "heatmap" ? "is-active" : ""}
								onClick={() => setMapVisualization("heatmap")}
							>
								Heatmap
							</button>
						</div>
						<div className="sidebar-map-search-results" aria-live="polite">
							{savedStories.length === 0 ? (
								<p>Save a recording as a story first. Its transcript keywords and locations will be searchable here.</p>
							) : !mapKeywordSearch.trim() ? (
								<p>{mapVisualization === "heatmap"
									? "Enter a search term to build a heatmap from matching transcript lines."
									: "Search for a term to highlight matching transcripts and keywords."}</p>
							) : matchingMapStories.length > 0 ? (
								<>
									<p className="sidebar-map-result-count">
										{matchingMapSegmentCount} matching {matchingMapSegmentCount === 1 ? "segment" : "segments"} across {matchingMapStories.length} {matchingMapStories.length === 1 ? "story" : "stories"}
									</p>
									<ul>
										{matchingMapStories.map((story) => (
											<li key={story.id}>
												<button type="button" onClick={() => openSavedStory(story.id)}>
													{story.title}
												</button>
											</li>
										))}
									</ul>
								</>
							) : (
								<p>No saved transcript or keywords match that search.</p>
							)}
						</div>
					</section>
				)}
				{activePage === "savedStories" && (
					<section className="sidebar-saved-stories" aria-labelledby="saved-stories-heading">
						{selectedStory ? (
							<section id="sidebar-story-page" className="sidebar-story-page" aria-label={`${selectedStory.title} details`}>
								<div className="sidebar-story-page-header">
									<button
										type="button"
										className="sidebar-story-close"
										onClick={closeStoryDetails}
										aria-label="Back to saved stories"
										title="Back to saved stories"
									>
										×
									</button>
									<button
										type="button"
										className="sidebar-story-title-toggle"
										aria-expanded="true"
										aria-controls="sidebar-story-page-content"
										onClick={closeStoryDetails}
									>
										{selectedStory.title}
									</button>
								</div>
								<div id="sidebar-story-page-content" className="sidebar-story-page-content">
									<section className="sidebar-story-section">
										<h3>Transcript</h3>
										<p>{selectedStory.text || "No transcript was captured for this story."}</p>
									</section>
									<section className="sidebar-story-section">
										<h3>Recording</h3>
										{storyAudioUrl ? (
											<audio controls preload="metadata" src={storyAudioUrl} />
										) : (
											<p>No audio recording is available for this story.</p>
										)}
									</section>
									<section className="sidebar-story-section">
										<h3>Keywords</h3>
										{selectedStoryKeywords.length > 0 ? (
											<ul className="journey-keywords">
												{selectedStoryKeywords.map((keyword) => <li key={keyword}>{keyword}</li>)}
											</ul>
										) : (
											<p>No keywords found for this story.</p>
										)}
									</section>
								</div>
							</section>
						) : (
							<>
								<div className="sidebar-saved-stories-heading">
									<h2 id="saved-stories-heading">Saved stories</h2>
									<span>{savedStories.length}</span>
								</div>
								{savedStories.length > 0 ? (
									<ul className="saved-story-names">
										{savedStories.map((story) => (
											<li key={story.id}>
												{editingStoryId === story.id ? (
													<form className="saved-story-rename-form" onSubmit={renameStory}>
														<input
															autoFocus
															aria-label="Story name"
															value={storyTitleDraft}
															onChange={(event) => setStoryTitleDraft(event.target.value)}
														/>
														<button type="submit" disabled={!storyTitleDraft.trim()}>Save</button>
														<button
															type="button"
															onClick={() => {
																setEditingStoryId(null);
																setStoryTitleDraft("");
															}}
														>
															Cancel
														</button>
													</form>
												) : (
													<>
														<button
															type="button"
															className="saved-story-name"
															aria-expanded={false}
															aria-controls="sidebar-story-page"
															onClick={() => setSelectedStoryId(story.id)}
														>
															{story.title}
														</button>
														<button
															type="button"
															className="saved-story-rename"
															onClick={() => {
																setEditingStoryId(story.id);
																setStoryTitleDraft(story.title);
															}}
															aria-label={`Rename ${story.title}`}
														>
															Rename
														</button>
														<button
															type="button"
															className="saved-story-delete"
															onClick={() => deleteSavedStory(story)}
															aria-label={`Delete ${story.title} and its audio`}
														>
															Delete
														</button>
													</>
												)}
											</li>
										))}
									</ul>
								) : (
									<p className="saved-stories-empty">Stories you save after recording will appear here.</p>
								)}
						</>
						)}
					</section>
				)}
			</aside>
			<main className="home-page" style={styles.page}>
				<header style={styles.header}>
				<div style={styles.brand}>
					<div style={styles.brandMark} aria-hidden="true">◎</div>
					<div>
						<p style={styles.eyebrow}>FIELD NOTES</p>
						<h1 style={styles.heading}>Voice map</h1>
					</div>
				</div>
				<div style={styles.headerActions}>
					<p role="status" style={styles.status}>
						<span style={{ ...styles.statusDot, backgroundColor: recording && !paused ? "#d97745" : "#18794e" }} />
						{status}
					</p>
					<button
						type="button"
						onClick={startRecording}
						disabled={recording}
						style={{ ...styles.button, ...styles.startButton }}
					>
						{recording ? "Recording…" : "Start recording"}
					</button>
					<button
						type="button"
						onClick={paused ? resumeRecording : pauseRecording}
						disabled={!recording}
						style={{ ...styles.button, ...styles.pauseButton }}
					>
						{paused ? "Resume" : "Pause"}
					</button>
					<button
						type="button"
						onClick={stopRecording}
						disabled={!recording}
						style={{ ...styles.button, ...styles.stopButton }}
					>
						Stop
					</button>
				</div>
				</header>
			{showStoryPrompt && (
				<div style={styles.storyPromptBackdrop}>
					<section
						className="story-prompt-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="story-prompt-title"
						style={styles.storyPrompt}
					>
						<h2 id="story-prompt-title" style={styles.storyPromptTitle}>
							Add story to map?
						</h2>
						{storySaveError && (
							<p className="story-save-error" role="alert">
								{storySaveError}
								{storySaveError.includes("user_id") && storySaveError.includes("schema cache") && (
									<>
										{" "}Run the Supabase ownership migration once in your project's SQL Editor, then reload the app.
									</>
								)}
							</p>
						)}
						<div style={styles.storyPromptActions}>
							<button
								type="button"
								onClick={addStoryToMap}
								disabled={savingStory || !storiesLoaded}
								style={{ ...styles.button, ...styles.addStoryButton }}
							>
								{savingStory
									? "Saving…"
									: !authLoaded
										? "Checking account…"
										: !authUserId
											? "Sign in to save"
											: !storiesLoaded
												? "Loading…"
												: "Add"}
							</button>
							<button
								type="button"
								onClick={discardRecording}
								style={{ ...styles.button, ...styles.deleteStoryButton }}
							>
								Delete
							</button>
						</div>
					</section>
				</div>
			)}
			<section style={styles.mapSection} aria-label="Transcript route map">
				<div ref={mapElementRef} style={styles.map} />
				<aside className={`map-story-sidebar${storiesExpanded ? " is-expanded" : ""}`}>
					<button
						type="button"
						className="map-story-toggle"
						aria-expanded={storiesExpanded}
						aria-controls="saved-map-stories"
						onClick={() => setStoriesExpanded((expanded) => !expanded)}
					>
						{storiesExpanded ? "Hide stories" : `Saved stories (${savedStories.length})`}
					</button>
					{storiesExpanded && (
						<div id="saved-map-stories" className="map-story-content">
							<h2 className="map-story-heading">Saved stories</h2>
							{savedStories.length > 0 ? savedStories.map((story) => (
								<button
									key={story.id}
									type="button"
									className={`map-story-name${selectedStoryId === story.id ? " is-selected" : ""}`}
									onClick={() => openSavedStory(story.id)}
								>
									{story.title}
								</button>
							)) : (
								<p className="map-story-empty">Stories you add will appear here.</p>
							)}
						</div>
					)}
				</aside>
				<div style={styles.mapBadge}>
					<span style={styles.mapBadgeDot} />
					{mapSegments.length} {mapSegments.length === 1 ? "line segment" : "line segments"}
					{journeyReady && transcriptSegments.length > 1 && " · Route connected"}				</div>
				{activePage === "home" && mapSegments.length === 0 && (
					<div style={styles.mapHint}>
						<strong>Your walk, traced on the map.</strong>
						<span>Start recording to add your first route segment.</span>
					</div>
				)}
				{activePage === "map" && mapSegments.length === 0 && (
					<div style={styles.mapHint}>
						<strong>No saved route segments to show yet.</strong>
						<span>
							{savedStories.length === 0
								? "Save a recording as a story to search its keywords and see its route segments here."
								: "Your saved stories do not have any transcript segments with a recorded route yet."}
						</span>
					</div>
				)}
			</section>
			{activePage === "home" && (
			<div style={styles.content}>
				{journeyReady && (
					<section style={styles.journeyCard} aria-live="polite">
						<p style={styles.eyebrow}>ALL RECORDINGS THIS SESSION</p>
						<h2 style={styles.journeyHeading}>Most-mentioned keywords</h2>
						{journeySummary.length > 0 ? (
							<ul className="journey-keywords">
								{journeySummary.map((keyword) => (
									<li key={keyword}>
										{keyword}
									</li>
								))}
							</ul>
						) : (
							<p style={styles.journeyText}>No transcript was captured for this journey.</p>
						)}
						<p style={styles.journeyNote}>
							Ranked locally across every recording since this page was opened.
						</p>
					</section>
				)}
				{selectedSegment && (
					<section style={styles.selectedCard} aria-live="polite">
						<div style={styles.selectedHeader}>
							<div>
								<p style={styles.eyebrow}>TRANSCRIPT LINE · INTERVAL {selectedSegment.index + 1}</p>
								<h2 style={styles.selectedTitle}>Transcript segment</h2>
							</div>
							<button
								type="button"
								onClick={() => setSelectedSegment(null)}
								style={styles.closeButton}
								aria-label="Close selected transcript"
							>
								×
							</button>
						</div>
						<p style={styles.selectedTranscript}>
							{selectedSegment.text || "No transcript was captured during this interval."}
						</p>
						<p style={styles.selectedCoordinates}>
							Start: {selectedSegment.startLocation.latitude.toFixed(6)}, {selectedSegment.startLocation.longitude.toFixed(6)}
							{" | "}
							End: {selectedSegment.endLocation.latitude.toFixed(6)}, {selectedSegment.endLocation.longitude.toFixed(6)}
						</p>
					</section>
				)}
				<section style={styles.transcriptSection} aria-live="polite">
					<div style={styles.sectionHeader}>
						<div>
							<p style={styles.eyebrow}>YOUR RECORDING</p>
							<h2 style={styles.transcriptHeading}>Transcript</h2>
						</div>
						<p style={styles.transcriptionStatus}>
							{transcriptionStatus || "Your speech will appear here."}
						</p>
					</div>
					{transcriptSegments.length > 0 ? (
						<div style={styles.segments}>
							{transcriptSegments.map((segment, index) => {
								const startSeconds = index * 30;
								const endSeconds = startSeconds + 30;
								const formatTime = (seconds) =>
									`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
								return (
									<div key={index} style={styles.liveData}>
										<div style={styles.segmentTime}>
											<span style={styles.segmentNumber}>{String(index + 1).padStart(2, "0")}</span>
											<span>{formatTime(startSeconds)}–{formatTime(endSeconds)}</span>
										</div>
										<div style={styles.segmentBody}>
											<p style={styles.transcript}>
												{segment.text}
												{segment.interim && (
													<span style={styles.interimTranscript}>{segment.interim}</span>
												)}
												{!segment.text && !segment.interim && "No speech in this interval."}
											</p>
											<p style={styles.locationStatus}>
												{segment.startLocation
													? `Start: ${segment.startLocation.latitude.toFixed(6)}, ${segment.startLocation.longitude.toFixed(6)}`
													: segment.locationStatus}
											</p>
											{segment.endLocation && (
												<p style={styles.locationStatus}>
													End: {segment.endLocation.latitude.toFixed(6)}, {segment.endLocation.longitude.toFixed(6)}
												</p>
											)}
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<p style={styles.emptyTranscript}>Start recording to begin transcription and location sampling.</p>
					)}
					<p style={styles.transcriptionNote}>
						Transcription uses your browser’s speech service, which may send audio to its provider. Map summaries are selected locally on this device; transcript text is not sent to an AI summarization service. Location is requested every 30 seconds; your browser may require HTTPS and permission.
					</p>
				</section>
				{audioUrl && <audio controls src={audioUrl} style={styles.audio} />}
			</div>
			)}
			</main>
		</div>
	);
}

// These style settings control the page layout and appearance. For example,
// "gap" adds space between items and "backgroundColor" sets the page color.
const styles = {
	page: {
		minHeight: "100vh",
		fontFamily: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
		backgroundColor: "#f6f5f0",
		color: "#21332a",
	},
	header: {
		minHeight: "90px",
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: "1rem",
		padding: "1rem clamp(1.25rem, 5vw, 4.5rem)",
		backgroundColor: "#fbfaf7",
		borderBottom: "1px solid #e7e5dd",
	},
	brand: { display: "flex", alignItems: "center", gap: "0.8rem" },
	brandMark: {
		width: "42px",
		height: "42px",
		display: "grid",
		placeItems: "center",
		borderRadius: "50%",
		backgroundColor: "#e7efe8",
		color: "#18794e",
		fontSize: "2rem",
		lineHeight: 1,
	},
	eyebrow: {
		margin: "0 0 0.25rem",
		color: "#748078",
		fontSize: "0.67rem",
		fontWeight: 700,
		letterSpacing: "0.15em",
	},
	heading: { margin: 0, fontSize: "1.25rem", letterSpacing: "-0.03em" },
	headerActions: { display: "flex", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: "0.65rem" },
	button: {
		border: "1px solid transparent",
		borderRadius: "999px",
		padding: "0.68rem 1.1rem",
		color: "white",
		fontSize: "0.9rem",
		fontWeight: 600,
		cursor: "pointer",
	},
	startButton: { backgroundColor: "#18794e" },
	stopButton: { backgroundColor: "#fff", color: "#59645d", borderColor: "#d9ddd8" },
	pauseButton: { backgroundColor: "#f0eee7", color: "#59645d", borderColor: "#d9ddd8" },
	storyPromptBackdrop: {
		position: "fixed",
		inset: 0,
		zIndex: 1000,
		display: "grid",
		placeItems: "center",
		padding: "1rem",
		backgroundColor: "rgba(24, 36, 29, 0.35)",
	},
	storyPrompt: {
		width: "min(100%, 360px)",
		padding: "1.5rem",
		border: "1px solid #e4e2da",
		borderRadius: "16px",
		backgroundColor: "#fbfaf7",
		boxShadow: "0 16px 48px rgba(32, 48, 37, 0.2)",
	},
	storyPromptTitle: { margin: "0 0 1.25rem", fontSize: "1.2rem", textAlign: "center" },
	storyPromptActions: { display: "flex", justifyContent: "center", gap: "0.75rem" },
	addStoryButton: { backgroundColor: "#18794e" },
	deleteStoryButton: { backgroundColor: "#fff", color: "#59645d", borderColor: "#d9ddd8" },
	status: { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0 0.5rem 0 0", color: "#59645d", fontSize: "0.82rem" },
	statusDot: { width: "8px", height: "8px", borderRadius: "50%" },
	mapSection: { position: "relative", height: "min(63vh, 650px)", minHeight: "360px", backgroundColor: "#e6e8dd" },
	map: { width: "100%", height: "100%", zIndex: 0 },
	mapBadge: {
		position: "absolute",
		zIndex: 500,
		top: "1.1rem",
		left: "1.1rem",
		display: "flex",
		alignItems: "center",
		gap: "0.5rem",
		padding: "0.65rem 0.9rem",
		border: "1px solid rgba(33, 51, 42, 0.08)",
		borderRadius: "999px",
		backgroundColor: "rgba(251, 250, 247, 0.94)",
		color: "#3d5145",
		fontSize: "0.82rem",
		fontWeight: 600,
		boxShadow: "0 3px 14px rgba(32, 48, 37, 0.1)",
	},
	mapBadgeDot: { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#18794e" },
	mapHint: {
		position: "absolute",
		zIndex: 400,
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		display: "flex",
		flexDirection: "column",
		gap: "0.4rem",
		width: "min(85%, 340px)",
		padding: "1.25rem",
		borderRadius: "12px",
		backgroundColor: "rgba(251, 250, 247, 0.94)",
		textAlign: "center",
		boxShadow: "0 6px 24px rgba(32, 48, 37, 0.12)",
	},
	content: { width: "min(calc(100% - 2rem), 900px)", margin: "0 auto", padding: "2rem 0 4rem" },
	journeyCard: {
		marginBottom: "1.5rem",
		padding: "1.5rem 1.6rem",
		border: "1px solid #e1e7df",
		borderRadius: "12px",
		backgroundColor: "#eef3ed",
	},
	journeyHeading: { margin: 0, fontSize: "1.25rem", letterSpacing: "-0.03em" },
	journeyText: { margin: "0.8rem 0 0", lineHeight: 1.7 },
	journeyNote: { margin: "0.8rem 0 0", color: "#748078", fontSize: "0.78rem", lineHeight: 1.5 },
	selectedCard: {
		marginBottom: "1.5rem",
		padding: "1.25rem 1.5rem",
		border: "1px solid #dce5dc",
		borderRadius: "12px",
		backgroundColor: "#edf3ed",
	},
	selectedHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" },
	selectedTitle: { margin: 0, fontSize: "1.1rem" },
	closeButton: { border: 0, background: "transparent", color: "#56665a", fontSize: "1.5rem", cursor: "pointer" },
	selectedTranscript: { margin: "1rem 0", lineHeight: 1.65, whiteSpace: "pre-wrap" },
	selectedCoordinates: { margin: 0, color: "#68776e", fontFamily: "monospace", fontSize: "0.8rem" },
	transcriptSection: {
		padding: "1.5rem 1.6rem",
		border: "1px solid #e4e2da",
		borderRadius: "12px",
		backgroundColor: "#fbfaf7",
	},
	sectionHeader: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "1rem", marginBottom: "0.8rem" },
	transcriptHeading: { margin: 0, fontSize: "1.35rem", letterSpacing: "-0.03em" },
	transcriptionStatus: { margin: "0 0 0.15rem", color: "#748078", fontSize: "0.85rem", textAlign: "right" },
	liveData: {
		display: "grid",
		gridTemplateColumns: "130px minmax(0, 1fr)",
		gap: "1rem",
		padding: "1.1rem 0",
		borderTop: "1px solid #e9e7df",
	},
	segments: { display: "flex", flexDirection: "column" },
	segmentTime: { display: "flex", alignItems: "flex-start", gap: "0.6rem", paddingTop: "0.1rem", color: "#748078", fontSize: "0.78rem" },
	segmentNumber: { color: "#18794e", fontWeight: 700 },
	segmentBody: { minWidth: 0 },
	transcript: { minHeight: "1.5em", margin: 0, lineHeight: 1.65, whiteSpace: "pre-wrap" },
	interimTranscript: { color: "#87928a" },
	locationStatus: { margin: "0.55rem 0 0", color: "#829087", fontFamily: "monospace", fontSize: "0.73rem" },
	emptyTranscript: { margin: "1.5rem 0", color: "#748078" },
	transcriptionNote: { margin: "1rem 0 0", color: "#87928a", fontSize: "0.75rem", lineHeight: 1.5 },
	audio: { width: "100%", marginTop: "1rem" },
};
