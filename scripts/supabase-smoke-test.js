import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readLocalEnvironment() {
	const file = new URL("../.env", import.meta.url);
	let contents;
	try {
		contents = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`Could not read the project .env file: ${error.message}`);
	}
	return Object.fromEntries(contents.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const separator = line.indexOf("=");
			if (separator < 0) return [line, ""];
			const key = line.slice(0, separator).trim();
			const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, "$2");
			return [key, value];
		}));
}

const localEnvironment = readLocalEnvironment();
const supabaseUrl = process.env.VITE_SUPABASE_URL || localEnvironment.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || localEnvironment.VITE_SUPABASE_ANON_KEY;
const testEmail = process.env.SUPABASE_TEST_EMAIL || localEnvironment.SUPABASE_TEST_EMAIL;
const testPassword = process.env.SUPABASE_TEST_PASSWORD || localEnvironment.SUPABASE_TEST_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey || !testEmail || !testPassword) {
	console.error("Supabase smoke test requires the Supabase URL, anon key, and test account credentials in .env.");
	process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
	auth: { autoRefreshToken: false, persistSession: false },
});
const testId = `smoke-test-${randomUUID()}`;
let testUserId;
let signedIn = false;
let inserted = false;
let testFailed = false;

try {
	const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
		email: testEmail,
		password: testPassword,
	});
	if (signInError) throw new Error(`Test account sign-in failed: ${signInError.message}`);
	signedIn = true;
	testUserId = sessionData.user.id;

	const { error: insertError } = await supabase.from("stories").insert({
		id: testId,
		user_id: testUserId,
		title: "Supabase connection smoke test",
		transcript: "Temporary test record. No recording data.",
		recording_started_at: new Date().toISOString(),
		duration_seconds: 0,
	});
	if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
	inserted = true;

	const { data, error: selectError } = await supabase
		.from("stories")
		.select("id, title")
		.eq("id", testId)
		.single();
	if (selectError) throw new Error(`Read-back failed: ${selectError.message}`);
	if (data.id !== testId || data.title !== "Supabase connection smoke test") {
		throw new Error("Read-back returned a row that did not match the test record.");
	}

	console.log("Supabase stories insert/read smoke test passed.");
} catch (error) {
	testFailed = true;
	console.error(`Supabase stories smoke test failed: ${error.message}`);
} finally {
	if (inserted) {
		const { error: deleteError } = await supabase
			.from("stories")
			.delete()
			.eq("id", testId)
			.eq("user_id", testUserId);
		if (deleteError) {
			testFailed = true;
			console.error(`Could not clean up the temporary smoke-test row: ${deleteError.message}`);
		}
	}
	if (signedIn) {
		const { error: signOutError } = await supabase.auth.signOut();
		if (signOutError) {
			testFailed = true;
			console.error(`Could not sign out the smoke-test account: ${signOutError.message}`);
		}
	}
}

if (testFailed) process.exitCode = 1;
