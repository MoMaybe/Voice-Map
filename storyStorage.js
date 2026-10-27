import { summarizeTranscript } from "./summarizeTranscript.js";
import { getSegmentEndpoints } from "./spatialModel.js";
import { supabase } from "./supabase.js";

const DATABASE_NAME = "voice-map";
const DATABASE_VERSION = 1;
const STORY_STORE = "stories";

function openStoryDatabase() {
	return new Promise((resolve, reject) => {
		if (!window.indexedDB) {
			reject(new Error("This browser does not support local audio storage."));
			return;
		}

		const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORY_STORE)) {
				database.createObjectStore(STORY_STORE, { keyPath: "id" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error("Could not open local audio storage."));
		request.onblocked = () => reject(new Error("Local audio storage is blocked by another open tab."));
	});
}

async function runLocalTransaction(mode, operation) {
	const database = await openStoryDatabase();
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORY_STORE, mode);
		const request = operation(transaction.objectStore(STORY_STORE));
		let result;
		request.onsuccess = () => {
			result = request.result;
		};
		request.onerror = () => reject(request.error || new Error("Could not access locally saved audio."));
		transaction.oncomplete = () => {
			database.close();
			resolve(result);
		};
		transaction.onerror = () => {
			database.close();
			reject(transaction.error || new Error("Could not save local audio data."));
		};
		transaction.onabort = () => {
			database.close();
			reject(transaction.error || new Error("Local audio storage was interrupted."));
		};
	});
}

function getStoryTranscript(story) {
	return typeof story.text === "string"
		? story.text
		: (story.segments || [])
			.map((segment) => `${segment.text || ""}${segment.interim || ""}`.trim())
			.filter(Boolean)
			.join("\n\n");
}

function toSegmentRows(story, userId) {
	return (story.segments || []).map((segment, index) => {
		const transcript = `${segment.text || ""}${segment.interim || ""}`.trim();
		const endpoints = getSegmentEndpoints(segment);
		return {
			user_id: userId,
			story_id: story.id,
			latitude: endpoints?.startLocation.latitude ?? null,
			longitude: endpoints?.startLocation.longitude ?? null,
			start_latitude: endpoints?.startLocation.latitude ?? null,
			start_longitude: endpoints?.startLocation.longitude ?? null,
			end_latitude: endpoints?.endLocation.latitude ?? null,
			end_longitude: endpoints?.endLocation.longitude ?? null,
			transcript,
			keywords: segment.summary?.length ? segment.summary : summarizeTranscript(transcript),
			interval_start_seconds: index * 30,
			interval_end_seconds: Math.min((index + 1) * 30, story.durationSeconds || (index + 1) * 30),
		};
	});
}

async function insertStoryRows(story, userId) {
	const storyRow = {
		id: story.id,
		user_id: userId,
		title: story.title,
		transcript: getStoryTranscript(story),
		recording_started_at: story.recordingStartedAt || new Date().toISOString(),
		duration_seconds: story.durationSeconds || 0,
	};
	const segments = toSegmentRows(story, userId);

	const { error: storyError } = await supabase.from("stories").insert(storyRow);
	if (storyError) throw new Error(`Could not save story "${story.title}": ${storyError.message}`);

	if (segments.length === 0) return;
	const { error: segmentsError } = await supabase.from("segments").insert(segments);
	if (!segmentsError) return;

	const { error: cleanupSegmentsError } = await supabase
		.from("segments")
		.delete()
		.eq("story_id", story.id)
		.eq("user_id", userId);
	const { error: cleanupStoryError } = await supabase
		.from("stories")
		.delete()
		.eq("id", story.id)
		.eq("user_id", userId);
	if (cleanupSegmentsError || cleanupStoryError) {
		console.error("Could not roll back an incomplete story save.", {
			segmentsError: cleanupSegmentsError,
			storyError: cleanupStoryError,
		});
	}
	throw new Error(`Could not save story segments: ${segmentsError.message}`);
}

function mapSegmentRow(row) {
	const transcript = row.transcript || "";
	const legacyLocation = Number.isFinite(row.latitude) && Number.isFinite(row.longitude)
		? { latitude: row.latitude, longitude: row.longitude }
		: null;
	return {
		text: transcript,
		interim: "",
		complete: true,
		location: legacyLocation,
		startLocation: Number.isFinite(row.start_latitude) && Number.isFinite(row.start_longitude)
			? { latitude: row.start_latitude, longitude: row.start_longitude }
			: null,
		endLocation: Number.isFinite(row.end_latitude) && Number.isFinite(row.end_longitude)
			? { latitude: row.end_latitude, longitude: row.end_longitude }
			: null,
		locationStatus: legacyLocation ? "Location interval saved." : "No location was saved for this interval.",
		summary: Array.isArray(row.keywords) && row.keywords.length
			? row.keywords
			: summarizeTranscript(transcript),
		summarySourceText: transcript,
		intervalStartSeconds: row.interval_start_seconds,
		intervalEndSeconds: row.interval_end_seconds,
	};
}

function mapStoryRow(row, segmentRows, localStory) {
	const storySegments = segmentRows
		.filter((segment) => segment.story_id === row.id)
		.sort((left, right) => left.interval_start_seconds - right.interval_start_seconds)
		.map(mapSegmentRow);
	return {
		id: row.id,
		title: row.title || "Untitled story",
		text: row.transcript || "",
		segments: storySegments,
		audioBlob: localStory?.audioBlob || null,
		recordingStartedAt: row.recording_started_at,
		durationSeconds: row.duration_seconds || 0,
		cloudStored: true,
	};
}

export async function loadLocalStories() {
	return runLocalTransaction("readonly", (store) => store.getAll());
}

export async function loadSavedStories(userId) {
	if (!userId) throw new Error("Sign in before loading your cloud stories.");

	const localStories = await loadLocalStories();
	try {
		const { data: storyRows, error: storyError } = await supabase
			.from("stories")
			.select("id, user_id, title, transcript, recording_started_at, duration_seconds, created_at")
			.eq("user_id", userId)
			.order("created_at", { ascending: true });
		if (storyError) throw storyError;

		const remoteIds = new Set(storyRows.map((story) => story.id));
		let segmentRows = [];
		if (remoteIds.size > 0) {
			const { data, error } = await supabase
				.from("segments")
				.select("id, story_id, user_id, latitude, longitude, start_latitude, start_longitude, end_latitude, end_longitude, transcript, keywords, interval_start_seconds, interval_end_seconds")
				.eq("user_id", userId)
				.in("story_id", [...remoteIds])
				.order("interval_start_seconds", { ascending: true });
			if (error) throw error;
			segmentRows = data;
		}

		const localStoriesById = new Map(localStories.map((story) => [story.id, story]));
		let migratedCount = 0;
		for (const localStory of localStories) {
			if (remoteIds.has(localStory.id)) continue;
			await insertStoryRows(localStory, userId);
			remoteIds.add(localStory.id);
			storyRows.push({
				id: localStory.id,
				user_id: userId,
				title: localStory.title,
				transcript: getStoryTranscript(localStory),
				recording_started_at: localStory.recordingStartedAt,
				duration_seconds: localStory.durationSeconds || 0,
				created_at: localStory.recordingStartedAt,
			});
			segmentRows.push(...toSegmentRows(localStory, userId).map((segment, index) => ({
				...segment,
				id: `local-${localStory.id}-${index}`,
			})));
			migratedCount += 1;
		}

		return {
			stories: storyRows.map((story) =>
				mapStoryRow(story, segmentRows, localStoriesById.get(story.id)),
			),
			migratedCount,
			syncError: null,
		};
	} catch (error) {
		console.error("Could not load or migrate cloud stories.", error);
		return {
			stories: localStories.map((story) => ({ ...story, cloudStored: false })),
			migratedCount: 0,
			syncError: error,
		};
	}
}

export async function saveStory(story, userId) {
	if (!userId) throw new Error("Sign in before saving a story to Supabase.");
	if (story.audioBlob) {
		await runLocalTransaction("readwrite", (store) =>
			store.put({ id: story.id, audioBlob: story.audioBlob }),
		);
	}
	await insertStoryRows(story, userId);
}

export async function renameSavedStory(storyId, title, userId) {
	if (!userId) throw new Error("Sign in before renaming a cloud story.");
	const { data, error } = await supabase
		.from("stories")
		.update({ title })
		.eq("id", storyId)
		.eq("user_id", userId)
		.select("id")
		.maybeSingle();
	if (error) throw new Error(`Could not rename the saved story: ${error.message}`);
	if (data) return;

	const localStories = await loadLocalStories();
	const localStory = localStories.find((story) => story.id === storyId);
	if (!localStory) throw new Error("The story no longer exists in your account or local storage.");
	await runLocalTransaction("readwrite", (store) =>
		store.put({ ...localStory, title }),
	);
}

export async function deleteStory(storyId, userId) {
	if (!userId) throw new Error("Sign in before deleting a cloud story.");
	const { error: storyError } = await supabase
		.from("stories")
		.delete()
		.eq("id", storyId)
		.eq("user_id", userId);
	if (storyError) throw new Error(`Could not delete the saved story: ${storyError.message}`);

	await runLocalTransaction("readwrite", (store) => store.delete(storyId));
}
