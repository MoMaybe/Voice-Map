



import wordFilters from "./summaryWordFilters.json" with { type: "json" };

const customWords = new Set(wordFilters.customWords);
const stopWords = new Set(
	`a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just me more most mustn't my myself no nor not now of off on once only or other ought our ours ourselves out over own same she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves`.split(" "),
);

const fillerWords = new Set(
	`actually basically etc kind kinda like literally maybe okay ok perhaps probably really simply sort sorta um uh uh huh uhm well yeah yep yes`.split(" "),
);

const genericVerbs = new Set(
	`achieve achieved achieves achieving ask asked asking asks become became becoming becomes begin began beginning begins call called calling calls come came comes coming desire desired desires do does doing done explode exploded explodes exploding get gets getting got give gave given gives gaze gazed gazes gazing go goes going gone grew grow grows growing hear heard help helped helps keep kept know knew known knows let lets look looked looking looks make made makes making mean meant means move moved moving moves need needed needs pass passed passes passing put puts said say says saying see seeing seen sees seem seemed seems show showed shown shows start started starts stop stopped stops stopping take taken taking takes tell told tells think thought thinks try tried tries use used uses want wanted wants went work worked works`.split(" "),
);

const narrativeVerbs =
	`explain explained explains explaining live lived lives living saw watch watched watches watching`.split(" ");
narrativeVerbs.forEach((word) => genericVerbs.add(word));

const lowInformationWords = `near front down exactly slightly same back`.split(" ");
lowInformationWords.forEach((word) => stopWords.add(word));
wordFilters.stopWords.forEach((word) => stopWords.add(word));
wordFilters.fillerWords.forEach((word) => fillerWords.add(word));
wordFilters.genericWords.forEach((word) => genericVerbs.add(word));

const nounLikeEndings = /(age|ance|ence|ery|ment|ness|ship|tion|sion|ity|ism|ist|or)$/u;

function normalizeWord(word, preserveCapitalized = false) {
	const isCapitalized = preserveCapitalized && /^[\p{Lu}]/u.test(word);
	let normalized = word.toLocaleLowerCase().replace(/['’]s$/u, "");
	if (isCapitalized) return normalized;
	if (normalized.endsWith("ies") && normalized.length > 5) {
		normalized = `${normalized.slice(0, -3)}y`;
	} else if (
		normalized.endsWith("s") &&
		!normalized.endsWith("ss") &&
		!normalized.endsWith("es") &&
		normalized.length > 3
	) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

function extractCandidates(text) {
	const byWord = new Map();
	const occurrences = [];
	for (const matchResult of text.matchAll(/[\p{L}]+(?:['’][\p{L}]+)?/gu)) {
		const [match] = matchResult;
		const offset = matchResult.index;
		const beforeWord = text.slice(0, offset).trimEnd();
		const atSentenceStart = !beforeWord || /[.!?]["')\]]?$/u.test(beforeWord);
		const isProperNoun = !atSentenceStart && /^[\p{Lu}]/u.test(match);
		const normalized = normalizeWord(match, isProperNoun);
		if (
			normalized.length < 3 ||
			customWords.has(normalized) ||
			stopWords.has(normalized) ||
			fillerWords.has(normalized) ||
			genericVerbs.has(normalized)
		) {
			continue;
		}

		let candidate = byWord.get(normalized);
		if (!candidate) {
			candidate = {
				normalized,
				display: normalized,
				count: 0,
				properNounCount: 0,
				firstOffset: offset,
				nounEndingBonus: nounLikeEndings.test(normalized) ? 0.1 : 0,
				edges: new Map(),
				rank: 1,
			};
			byWord.set(normalized, candidate);
		}
		candidate.count += 1;
		if (isProperNoun) candidate.properNounCount += 1;
		occurrences.push(candidate);
	}
	return { candidates: [...byWord.values()], occurrences };
}

function connectNearbyWords(occurrences) {
	for (let index = 0; index < occurrences.length; index += 1) {
		for (let neighborIndex = index + 1; neighborIndex < Math.min(index + 5, occurrences.length); neighborIndex += 1) {
			const distance = neighborIndex - index;
			const weight = 1 / distance;
			const current = occurrences[index];
			const neighbor = occurrences[neighborIndex];
			if (current === neighbor) continue;
			current.edges.set(neighbor.normalized, (current.edges.get(neighbor.normalized) || 0) + weight);
			neighbor.edges.set(current.normalized, (neighbor.edges.get(current.normalized) || 0) + weight);
		}
	}
}

function rankByContext(tokens) {
	const tokensByWord = new Map(tokens.map((token) => [token.normalized, token]));
	const edgeWeights = new Map(
		tokens.map((token) => [
			token.normalized,
			[...token.edges.values()].reduce((sum, edge) => sum + edge, 0),
		]),
	);
	const damping = 0.85;
	for (let iteration = 0; iteration < 20; iteration += 1) {
		for (const token of tokens) {
			let linkedScore = 0;
			for (const [neighborKey, weight] of token.edges) {
				const neighbor = tokensByWord.get(neighborKey);
				const totalNeighborWeight = edgeWeights.get(neighborKey);
				if (totalNeighborWeight > 0) {
					linkedScore += weight * neighbor.rank / totalNeighborWeight;
				}
			}
			token.nextRank = 1 - damping + damping * linkedScore;
		}
		for (const token of tokens) token.rank = token.nextRank;
	}
}

function rankKeywords(text) {
	const { candidates, occurrences } = extractCandidates(text);
	if (candidates.length === 0) return [];
	connectNearbyWords(occurrences);
	rankByContext(candidates);

	return candidates
		.map((candidate) => ({
			...candidate,
			score:
				candidate.rank *
					(1 + Math.log1p(candidate.count) * 0.45 + candidate.nounEndingBonus) +
				Math.log1p(candidate.properNounCount) * 2.5,
		}))
		.sort((left, right) =>
			right.score - left.score ||
			right.count - left.count ||
			left.firstOffset - right.firstOffset);
}

export function summarizeTranscript(transcript) {
	if (typeof transcript !== "string") return [];
	const text = transcript.trim();
	if (!text) return [];

	return rankKeywords(text)
		.slice(0, 3)
		.map(({ display }) => `${display[0].toLocaleUpperCase()}${display.slice(1)}`);
}

export function summarizeJourneyKeywords(transcripts) {
	const allTranscriptText = Array.isArray(transcripts)
		? transcripts
			.filter((transcript) => typeof transcript === "string")
			.join(" ")
			.trim()
		: "";
	if (!allTranscriptText) return [];

	return rankKeywords(allTranscriptText)
		.sort((left, right) =>
			right.score - left.score ||
			right.count - left.count ||
			left.firstOffset - right.firstOffset)
		.slice(0, 12)
		.map(({ display }) => `${display[0].toLocaleUpperCase()}${display.slice(1)}`);
}

function splitIntoSentences(text) {
	const normalizedText = text.replace(/([.!?])(?=[\p{Lu}])/gu, "$1 ");
	const sentences = normalizedText
		.split(/(?<=[.!?])\s+|[\r\n]+/u)
		.map((sentence) => sentence.trim())
		.filter(Boolean);

	if (sentences.length === 1 && sentences[0].split(/\s+/u).length > 36) {
		return sentences[0]
			.split(/(?<=[,;:])\s+/u)
			.map((sentence) => sentence.trim())
			.filter(Boolean);
	}
	return sentences;
}

export function summarizeJourney(transcripts) {
	if (!Array.isArray(transcripts)) return [];
	const sourceSections = transcripts
		.map((transcript, sectionIndex) => ({
			sectionIndex,
			text: typeof transcript === "string" ? transcript.trim() : "",
		}))
		.filter((section) => section.text);
	if (sourceSections.length === 0) return [];

	const allTranscriptText = sourceSections.map(({ text }) => text).join(" ");
	const topics = rankKeywords(allTranscriptText).slice(0, 3);
	if (topics.length === 0) return [];

	const sentences = sourceSections.flatMap(({ sectionIndex, text }) =>
		splitIntoSentences(text).map((sentence) => {
			const sentenceWords = new Set(
				(sentence.match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) || []).map((word) =>
					normalizeWord(word),
				),
			);
			return { sectionIndex, sentence, terms: sentenceWords };
		}),
	);

	const usedSentences = new Set();
	return topics.map((topic) => {
		const candidates = sentences
			.map((candidate, index) => {
				if (!candidate.terms.has(topic.normalized)) return null;
				const relatedTopicScore = topics
					.filter((otherTopic) => otherTopic.normalized !== topic.normalized)
					.reduce(
						(total, otherTopic) =>
							total + (candidate.terms.has(otherTopic.normalized) ? otherTopic.score * 0.45 : 0),
						0,
					);
				const conciseSentenceBonus = 1 / Math.sqrt(candidate.sentence.split(/\s+/u).length);
				return {
					...candidate,
					index,
					score: topic.score + relatedTopicScore + conciseSentenceBonus,
				};
			})
			.filter(Boolean)
			.sort((left, right) => {
				const leftUsedBonus = usedSentences.has(left.index) ? -100 : 0;
				const rightUsedBonus = usedSentences.has(right.index) ? -100 : 0;
				return right.score + rightUsedBonus - (left.score + leftUsedBonus);
			});

		const selected = candidates[0];
		if (!selected) return null;
		usedSentences.add(selected.index);
		return {
			topic: `${topic.display[0].toLocaleUpperCase()}${topic.display.slice(1)}`,
			detail: selected.sentence,
			sectionIndex: selected.sectionIndex,
		};
	}).filter(Boolean);
}
