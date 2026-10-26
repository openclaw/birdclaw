export function roboclawHookConfiguration() {
	const raw = process.env.BIRDCLAW_ROBOCLAW_HOOK_URL?.trim();
	const token = process.env.BIRDCLAW_ROBOCLAW_HOOK_TOKEN?.trim();
	if (!raw || !token) return null;
	const url = new URL(raw);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.pathname.endsWith("/agent") ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
	) {
		throw new Error(
			"Use a dedicated HTTPS OpenClaw /hooks/agent URL (HTTP is loopback-only), without URL credentials or query parameters",
		);
	}
	return {
		url: url.toString(),
		token,
		agentId: process.env.BIRDCLAW_ROBOCLAW_AGENT_ID?.trim() || "roboclaw",
	};
}
