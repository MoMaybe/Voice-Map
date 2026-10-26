import assert from "node:assert/strict";
import test from "node:test";
import {
	summarizeJourney,
	summarizeJourneyKeywords,
	summarizeTranscript,
} from "./summarizeTranscript.js";

const keywords = (text) => summarizeTranscript(text).map((word) => word.toLowerCase());
const includesAny = (words, options) => options.some((word) => words.includes(word));

test("prioritizes names over filler in transcript keywords", () => {
	const words = keywords(
		"Harry stopped in front of the desk and gazed down at his 15 year old. Excitement exploded in the pit of his stomach. It was as though he was looking at himself, but with deliberate mistake. James desires were Hazel. His nose was slightly longer than Harry's. And there was no sky on his forehead. But they have the same thin face, same mouth, same eyebrows. James's hair stuck up at the back, exactly as Harris did. His hands could have been Harry's when Harry could tell that when James stood up.",
	);
	assert(words.includes("harry"));
	assert(words.includes("james"));
	assert(!includesAny(words, ["the", "and", "stopped", "gazed", "looking"]));
	assert(words.length <= 3);
});

test("ranks topics and excludes function words and generic verbs", () => {
	const words = keywords(
		"The storyteller told kids about crows. Crows lived near the family farm. Kids asked about crows.",
	);
	assert(words.includes("crow"));
	assert(words.includes("kid"));
	assert(includesAny(words, ["storyteller", "family"]));
	assert(!includesAny(words, ["the", "about", "told", "lived", "asked"]));
});

test("normalizes plurals and returns no keywords for empty or filler-only text", () => {
	const words = keywords("We saw crows and kids near families.");
	assert(words.includes("crow"));
	assert(words.includes("kid"));
	assert(words.includes("family"));
	assert.equal(words.length, 3);
	assert.deepEqual(summarizeTranscript("The and it you were."), []);
	assert.deepEqual(summarizeTranscript("   "), []);
});

test("ranks keywords across transcripts and normalizes repeated plurals", () => {
	const words = summarizeJourneyKeywords([
		"The family visited the forest and saw deer.",
		"The family returned to the forest with friends.",
		"Friends explored the forest near the river.",
	]).map((word) => word.toLowerCase());
	assert.equal(words[0], "forest");
	assert(words.includes("family"));
	assert(words.includes("friend"));
	assert(!includesAny(words, ["the", "and", "with", "near"]));
});

test("limits consolidated keywords to twelve and ignores filler-only text", () => {
	const transcripts = Array.from({ length: 15 }, (_, i) => {
		const topic = `topic${String.fromCharCode(97 + i)}`;
		return `${topic} ${topic} unique${String.fromCharCode(97 + i)}.`;
	});
	assert.equal(summarizeJourneyKeywords(transcripts).length, 12);
	assert.deepEqual(summarizeJourneyKeywords(["The and it you were.", ""]), []);
});

test("organizes original transcript sentences under distinct journey topics", () => {
	const transcripts = [
		"The storyteller talked with kids about crows near the family farm. Children watched birds by the barn.",
		"At the lake, children counted crows above the water and talked about their family trip.",
	];
	const points = summarizeJourney(transcripts);
	assert(points.length > 0 && points.length <= 3);
	assert(points.every(({ topic, detail }) => topic && detail));
	assert(points.every(({ detail }) => transcripts.some((text) => text.includes(detail))));
	assert.equal(new Set(points.map(({ topic }) => topic)).size, points.length);
});

test("returns no journey points without transcript text", () => {
	assert.deepEqual(summarizeJourney(["", "   "]), []);
});

test("finds useful words in varied transcript styles", () => {
	const transcripts = [
		"At sunrise, Maya's grandmother baked cinnamon bread in the old kitchen.",
		"Robots zoomed around the science museum while curious students built a rover!",
		"During our coastal hike, we spotted dolphins beside the cliffs and collected shells.",
		"After practice, the musicians tuned their violins before the winter concert.",
	];

	for (const transcript of transcripts) {
		const words = keywords(transcript);
		assert(words.length > 0, `expected keywords for: ${transcript}`);
		assert(words.length <= 3, `expected at most three keywords for: ${transcript}`);
		assert(!includesAny(words, ["the", "and", "while", "during", "before"]));
	}
});

test("handles punctuation, line breaks, and repeated topic words", () => {
	const points = summarizeJourney([
		"At the harbor, Ava watched seals. Then Ava counted boats!",
		"Later, the seals rested near the rocks.\nAva sketched the harbor.",
	]);

	assert(points.length > 0);
	assert(points.length <= 3);
	assert(points.every(({ topic, detail }) => topic && detail));
	assert(points.every(({ detail }) =>
		[
			"At the harbor, Ava watched seals.",
			"Then Ava counted boats!",
			"Later, the seals rested near the rocks.",
			"Ava sketched the harbor.",
		].includes(detail),
	));
});

test("ignores non-string entries when summarizing a journey", () => {
	const transcripts = [
		null,
		"Engineers tested solar panels on the rooftop. The panels powered a small greenhouse.",
		undefined,
		"",
	];

	assert(summarizeJourneyKeywords(transcripts).length > 0);
	assert(summarizeJourney(transcripts).every(({ detail }) =>
		transcripts.some((text) => typeof text === "string" && text.includes(detail)),
	));
});

test("keeps journey topics unique when multiple transcripts share the same themes", () => {
	const points = summarizeJourney([
		"Gardeners planted tomatoes beside the greenhouse. Tomatoes grew in the warm soil.",
		"Gardeners watered tomatoes each morning. The greenhouse kept the plants warm.",
	]);

	assert(points.length > 0);
	assert.equal(new Set(points.map(({ topic }) => topic.toLowerCase())).size, points.length);
	assert(points.every(({ detail }) => detail.endsWith(".") || detail.endsWith("!")));
});

test("prioritizes proper nouns across unrelated transcript topics", () => {
	const transcripts = [
		"Researchers discussed Aldebaran while studying distant stars and planets.",
		"Travelers visited Svalbard to observe glaciers and polar bears.",
		"Historians examined Petra and described the ancient stone architecture.",
	];
	const words = summarizeJourneyKeywords(transcripts).map((word) => word.toLowerCase());

	assert(words.includes("aldebaran"));
	assert(words.includes("svalbard"));
	assert(words.includes("petra"));
});

test("ranks a proper noun above a frequently repeated common word", () => {
	const transcript = `${Array(8).fill("water").join(" ")}. The researchers mention Aldebaran.`;
	const words = keywords(transcript);

	assert(words.includes("aldebaran"));
	assert(words.indexOf("aldebaran") < words.indexOf("water"));
});
