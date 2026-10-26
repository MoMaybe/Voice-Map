import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./app.css";
import { summarizeJourneyKeywords, summarizeTranscript } from "./summarizeTranscript.js";

// This is the main screen of the app. It records audio, asks the browser
// to turn speech into text, samples the device's location, and exports a CSV.
export default function App() {
	// A ref is a small storage box that React keeps between screen updates.
	// Unlike state, changing a ref does not redraw the screen. These refs are
	// useful for browser objects and for checking the latest recording status.
	const recorderRef = useRef(null);
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
	const markerLayerRef = useRef(null);
	const routeLayerRef = useRef(null);
	const mapHasCenteredRef = useRef(false);
	const recordingGenerationRef = useRef(0);
	const audioBlobRef = useRef(null);
	const audioBlobPromiseRef = useRef(Promise.resolve(null));

	// State is information shown on screen. Updating state tells React to redraw
	// the parts of the page that depend on the changed value.
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [status, setStatus] = useState("Ready to record");
	const [transcriptionStatus, setTranscriptionStatus] = useState("");
	const [transcriptSegments, setTranscriptSegments] = useState([]);
	const [transcriptHistory, setTranscriptHistory] = useState([]);
	const [audioUrl, setAudioUrl] = useState("");
	const [storyAudioUrl, setStoryAudioUrl] = useState("");
	const [savingStory, setSavingStory] = useState(false);
	const [selectedPoint, setSelectedPoint] = useState(null);
	const [journeyReady, setJourneyReady] = useState(false);
	const [showStoryPrompt, setShowStoryPrompt] = useState(false);
	const [savedStories, setSavedStories] = useState([]);
	const [storiesExpanded, setStoriesExpanded] = useState(false);
	const [activePage, setActivePage] = useState("home");
	const [selectedStoryId, setSelectedStoryId] = useState(null);
	const [editingStoryId, setEditingStoryId] = useState(null);
	const [storyTitleDraft, setStoryTitleDraft] = useState("");

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

	const visibleSegments = activePage === "savedStories" && selectedStory
		? selectedStory.segments
		: transcriptSegments;
	const mapPoints = useMemo(() => visibleSegments.flatMap((segment, index) => {
		const text = `${segment.text}${segment.interim}`.trim();
		if (!segment.complete || !segment.location || !text) return [];
		return [{
			index,
			text,
			location: segment.location,
			summary: segment.summary || [],
			summaryStatus: segment.summaryStatus || "",
		}];
	}), [visibleSegments]);

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
		markerLayerRef.current = L.layerGroup().addTo(map);
		routeLayerRef.current = L.layerGroup().addTo(map);

		return () => {
			map.remove();
			mapRef.current = null;
			markerLayerRef.current = null;
			routeLayerRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!mapRef.current || !markerLayerRef.current || !routeLayerRef.current) return;
		markerLayerRef.current.clearLayers();
		routeLayerRef.current.clearLayers();
		if ((journeyReady || (activePage === "savedStories" && selectedStory)) && mapPoints.length > 1) {
			L.polyline(
				mapPoints.map(({ location }) => [location.latitude, location.longitude]),
				{
					color: "#d27a4c",
					weight: 4,
					opacity: 0.85,
					lineCap: "round",
					lineJoin: "round",
				},
			).addTo(routeLayerRef.current);
		}

		const isStoryPoint = activePage === "savedStories" && Boolean(selectedStory);
		mapPoints.forEach((point) => {
			const marker = L.circleMarker(
				[point.location.latitude, point.location.longitude],
				{
					radius: isStoryPoint ? 12 : 9,
					color: "#ffffff",
					weight: isStoryPoint ? 4 : 3,
					fillColor: isStoryPoint ? "#d97745" : "#18794e",
					fillOpacity: 1,
				},
			).addTo(markerLayerRef.current);
			const popupContent = document.createElement("div");
			popupContent.className = "transcript-popup";
			const title = document.createElement("strong");
			title.className = "transcript-popup-title";
			title.textContent = `Voice note ${point.index + 1} · Main words`;
			popupContent.append(title);
			if (point.summary.length > 0) {
				const list = document.createElement("ul");
				list.className = "transcript-popup-points";
				point.summary.forEach((summaryPoint) => {
					const item = document.createElement("li");
					item.textContent = summaryPoint;
					list.append(item);
				});
				popupContent.append(list);
			} else {
				const summaryStatus = document.createElement("p");
				summaryStatus.className = "transcript-popup-status";
				summaryStatus.textContent = point.summaryStatus || "No transcript to summarize.";
				popupContent.append(summaryStatus);
			}
			const fullTranscript = document.createElement("details");
			fullTranscript.className = "transcript-popup-details";
			const detailsLabel = document.createElement("summary");
			detailsLabel.textContent = "View full transcript";
			const transcript = document.createElement("p");
			transcript.className = "transcript-popup-text";
			transcript.textContent = point.text;
			fullTranscript.append(detailsLabel, transcript);
			popupContent.append(fullTranscript);

			let hovered = false;
			let pinned = false;
			let closeTimeout = null;
			const popup = marker.bindPopup(popupContent, {
				autoClose: true,
				closeButton: true,
				closeOnClick: true,
				className: "transcript-map-popup",
				maxWidth: 320,
				offset: [0, -8],
			});
			const cancelClose = () => {
				if (closeTimeout) window.clearTimeout(closeTimeout);
				closeTimeout = null;
			};
			const closeOnPointerLeave = () => {
				cancelClose();
				closeTimeout = window.setTimeout(() => {
					if (!hovered && !pinned) marker.closePopup();
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

			marker.on("mouseover", () => {
				hovered = true;
				cancelClose();
				marker.openPopup();
			});
			marker.on("mouseout", () => {
				hovered = false;
				closeOnPointerLeave();
			});
			marker.on("click", () => {
				pinned = true;
				cancelClose();
				marker.openPopup();
				setSelectedPoint(point);
			});
			popup.on("popupclose", () => {
				pinned = false;
				hovered = false;
				cancelClose();
			});
		});

		if (mapPoints.length > 0 && activePage === "savedStories" && selectedStory) {
			const points = mapPoints.map(({ location }) => [location.latitude, location.longitude]);
			if (points.length > 1) {
				mapRef.current.fitBounds(points, { padding: [40, 40], maxZoom: 14 });
			} else {
				mapRef.current.setView(points[0], 14);
			}
			mapHasCenteredRef.current = true;
		} else if (mapPoints.length > 0 && !mapHasCenteredRef.current) {
			const latestPoint = mapPoints[mapPoints.length - 1];
			mapRef.current.setView([latestPoint.location.latitude, latestPoint.location.longitude], 14);
			mapHasCenteredRef.current = true;
		}
	}, [activePage, journeyReady, mapPoints, selectedStory]);

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
			location: null,
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
	function updateLocation(segmentIndex, requestId) {
		if (!navigator.geolocation || locationPermissionDeniedRef.current) {
			return;
		}

		navigator.geolocation.getCurrentPosition(
			(position) => {
				// Ignore answers from an older recording, but allow a slow location
				// lookup to finish after Stop so its transcript can still be pinned.
				if (requestId !== locationRequestIdRef.current) return;
				updateTranscriptSegment(segmentIndex, (segment) => ({
					...segment,
					location: {
						latitude: position.coords.latitude,
						longitude: position.coords.longitude,
					},
					locationStatus: "Location updated.",
				}));
			},
			(error) => {
				if (requestId !== locationRequestIdRef.current) return;

				const messages = {
					1: "Location permission was denied.",
					2: "Your current location is unavailable.",
					3: "Getting your location timed out; will try again.",
				};
				// Location errors are kept with the relevant time section too,
				// so the CSV can explain why coordinates are missing.
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
			updateLocation(segmentIndex, requestId);
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

	// Turn all transcript sections into a downloadable spreadsheet file.
	function downloadTranscriptCsv() {
		// Round the recording length up to a whole second for the last row's end time.
		const elapsedSeconds = Math.max(0, Math.ceil(getActiveElapsedMs() / 1000));
		// CSV files use commas to separate cells. Wrap each value in quotes and
		// double any quotes inside it so punctuation in speech stays in one cell.
		// The leading apostrophe also prevents spreadsheet formulas from running.
		const escapeCsvCell = (value) => {
			const text = String(value ?? "");
			const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
			return `"${safeText.replaceAll('"', '""')}"`;
		};
		const rows = [
			// These are the column titles shown when the CSV opens in a spreadsheet.
			[
				"recording_started_at",
				"interval_start_seconds",
				"interval_end_seconds",
				"transcript",
				"latitude",
				"longitude",
				"location_status",
			],
			// Make one row per time section, including a blank coordinate if
			// the browser could not provide a location.
			...transcriptSegmentsRef.current.map((segment, index) => [
				new Date(recordingStartedAtRef.current).toISOString(),
				index * 30,
				Math.min((index + 1) * 30, elapsedSeconds),
				`${segment.text}${segment.interim}`,
				segment.location?.latitude ?? "",
				segment.location?.longitude ?? "",
				segment.locationStatus,
			]),
		];
		// The BOM helps spreadsheet apps recognize the file's text encoding.
		const csv = `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n")}`;
		// Browsers download a temporary file URL rather than saving directly
		// into a folder chosen by the app.
		const fileUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
		const link = document.createElement("a");
		// Use the recording's date and time to make each downloaded filename unique.
		const fileTimestamp = new Date(recordingStartedAtRef.current)
			.toISOString()
			.replaceAll(":", "-");
		link.href = fileUrl;
		link.download = `transcript-${fileTimestamp}.csv`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		// Free the temporary URL after the browser has had time to start the download.
		window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
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
			recorder.addEventListener("stop", () => {
				// Combine the audio pieces into one playable recording.
				const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
				audioBlobRef.current = blob;
				resolveAudioBlob(blob);
				setAudioUrl((previousUrl) => {
					// Free the previous playback URL before replacing it.
					if (previousUrl) URL.revokeObjectURL(previousUrl);
					return URL.createObjectURL(blob);
				});
				stream.getTracks().forEach((track) => track.stop());
				streamRef.current = null;
				recorderRef.current = null;
				// The recognizer stops separately; clear its references after
				// the audio recorder has completed.
				recognitionRef.current = null;
				recognitionActiveRef.current = false;
				try {
					// Stopping also creates the CSV download.
					downloadTranscriptCsv();
					setStatus("Recording and transcript CSV saved. Play the audio below.");
				} catch (error) {
					console.error("Could not download the transcript CSV.", error);
					setStatus("Recording saved, but the transcript CSV could not be downloaded.");
				}
			});

			// Start audio capture first, then initialize speech recognition.
			recorder.start();
			audioBlobRef.current = null;
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
			setSelectedPoint(null);
			setSelectedStoryId(null);
			setActivePage("home");
			setJourneyReady(false);
			setShowStoryPrompt(false);
			mapHasCenteredRef.current = false;
			recordingStartedAtRef.current = Date.now();
			activeElapsedMsRef.current = 0;
			activeStartedAtRef.current = recordingStartedAtRef.current;
			createTranscriptSegment();
			locationPermissionDeniedRef.current = false;
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
		finalizeTranscriptSegment(transcriptSegmentsRef.current.length - 1);
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
		setSavingStory(true);
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
		setSavedStories((stories) => [
			...stories,
			{
				id,
				title: `Story ${storyNumberWords[storyNumber - 1] || storyNumber}`,
				text,
				segments,
				audioBlob,
			},
		]);
		setSelectedStoryId(null);
		setActivePage("savedStories");
		setShowStoryPrompt(false);
		setSavingStory(false);
	}

	function renameStory(event) {
		event.preventDefault();
		const title = storyTitleDraft.trim();
		if (!title) return;
		setSavedStories((stories) => stories.map((story) =>
			story.id === editingStoryId ? { ...story, title } : story,
		));
		setEditingStoryId(null);
		setStoryTitleDraft("");
	}

	function closeStoryDetails() {
		setSelectedStoryId(null);
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
				<nav className="sidebar-navigation" aria-label="Main navigation">
					<button
						type="button"
						className={`sidebar-button${activePage === "home" ? " is-active" : ""}`}
						aria-current={activePage === "home" ? "page" : undefined}
						onClick={() => setActivePage("home")}
					>
						Home
					</button>
					<button type="button" className="sidebar-button" disabled>
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
						role="dialog"
						aria-modal="true"
						aria-labelledby="story-prompt-title"
						style={styles.storyPrompt}
					>
						<h2 id="story-prompt-title" style={styles.storyPromptTitle}>
							Add story to map?
						</h2>
						<div style={styles.storyPromptActions}>
							<button
								type="button"
								onClick={addStoryToMap}
								disabled={savingStory}
								style={{ ...styles.button, ...styles.addStoryButton }}
							>
								{savingStory ? "Saving…" : "Add"}
							</button>
							<button type="button" style={{ ...styles.button, ...styles.deleteStoryButton }}>
								Delete
							</button>
						</div>
					</section>
				</div>
			)}
			<section style={styles.mapSection} aria-label="Transcript locations map">
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
									onClick={() => setSelectedStoryId(story.id)}
								>
									{story.title}
								</button>
							)) : (
								<p className="map-story-empty">Stories you add will appear here.</p>
							)}
							{selectedStory && (
								<aside className="map-story-transcript" aria-live="polite">
									<h3>{selectedStory.title}</h3>
									<p>{selectedStory.text
										|| "No transcript was captured for this story."}</p>
								</aside>
							)}
						</div>
					)}
				</aside>
				<div style={styles.mapBadge}>
					<span style={styles.mapBadgeDot} />
					{mapPoints.length} {mapPoints.length === 1 ? "voice note" : "voice notes"}
					{journeyReady && mapPoints.length > 1 && " · Route connected"}
				</div>
				{mapPoints.length === 0 && (
					<div style={styles.mapHint}>
						<strong>Your story, pinned to the map.</strong>
						<span>Start recording to add your first location.</span>
					</div>
				)}
			</section>
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
				{selectedPoint && (
					<section style={styles.selectedCard} aria-live="polite">
						<div style={styles.selectedHeader}>
							<div>
								<p style={styles.eyebrow}>PINNED TRANSCRIPT · NOTE {selectedPoint.index + 1}</p>
								<h2 style={styles.selectedTitle}>Voice note</h2>
							</div>
							<button
								type="button"
								onClick={() => setSelectedPoint(null)}
								style={styles.closeButton}
								aria-label="Close selected transcript"
							>
								×
							</button>
						</div>
						<p style={styles.selectedTranscript}>{selectedPoint.text}</p>
						<p style={styles.selectedCoordinates}>
							{selectedPoint.location.latitude.toFixed(6)}, {selectedPoint.location.longitude.toFixed(6)}
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
												{segment.location
													? `${segment.location.latitude.toFixed(6)}, ${segment.location.longitude.toFixed(6)}`
													: segment.locationStatus}
											</p>
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
