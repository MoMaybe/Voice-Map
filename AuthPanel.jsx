import { useState } from "react";
import { supabase } from "./supabase.js";

export default function AuthPanel({ session, loading }) {
	const [mode, setMode] = useState("signIn");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	async function submitAuth(event) {
		event.preventDefault();
		setBusy(true);
		setMessage("");
		try {
			if (mode === "signUp") {
				const { data, error } = await supabase.auth.signUp({ email, password });
				if (error) throw error;
				setMessage(data.session
					? "Account created and signed in."
					: "Check your email to confirm the new account, then sign in.");
			} else {
				const { error } = await supabase.auth.signInWithPassword({ email, password });
				if (error) throw error;
				setMessage("Signed in. Your saved stories are syncing.");
			}
		} catch (error) {
			console.error("Could not complete account authentication.", error);
			setMessage(`Authentication failed: ${error.message}`);
		} finally {
			setBusy(false);
		}
	}

	async function signOut() {
		setBusy(true);
		setMessage("");
		try {
			const { error } = await supabase.auth.signOut();
			if (error) throw error;
			setMessage("Signed out.");
		} catch (error) {
			console.error("Could not sign out.", error);
			setMessage(`Could not sign out: ${error.message}`);
		} finally {
			setBusy(false);
		}
	}

	if (loading) {
		return <p className="sidebar-auth-message" role="status">Checking account…</p>;
	}

	if (session?.user) {
		return (
			<section className="sidebar-auth-panel" aria-label="Account">
				<p className="sidebar-auth-account">Signed in as {session.user.email}</p>
				<button type="button" onClick={signOut} disabled={busy}>
					{busy ? "Please wait…" : "Sign out"}
				</button>
				{message && <p className="sidebar-auth-message" role="status">{message}</p>}
			</section>
		);
	}

	return (
		<form className="sidebar-auth-panel" onSubmit={submitAuth}>
			<h2>{mode === "signIn" ? "Sign in to sync" : "Create an account"}</h2>
			<label htmlFor="account-email">Email</label>
			<input
				id="account-email"
				type="email"
				autoComplete="email"
				required
				value={email}
				onChange={(event) => setEmail(event.target.value)}
			/>
			<label htmlFor="account-password">Password</label>
			<input
				id="account-password"
				type="password"
				autoComplete={mode === "signIn" ? "current-password" : "new-password"}
				minLength={6}
				required
				value={password}
				onChange={(event) => setPassword(event.target.value)}
			/>
			<p className="sidebar-auth-note">
				Signing in syncs saved transcripts and locations, including existing local stories. Audio stays on this device.
			</p>
			<button className="sidebar-auth-submit" type="submit" disabled={busy}>
				{busy ? "Please wait…" : mode === "signIn" ? "Sign in" : "Create account"}
			</button>
			<button
				className="sidebar-auth-switch"
				type="button"
				disabled={busy}
				onClick={() => {
					setMessage("");
					setMode((current) => current === "signIn" ? "signUp" : "signIn");
				}}
			>
				{mode === "signIn" ? "Need an account? Create one" : "Already have an account? Sign in"}
			</button>
			{message && <p className="sidebar-auth-message" role="status">{message}</p>}
		</form>
	);
}
