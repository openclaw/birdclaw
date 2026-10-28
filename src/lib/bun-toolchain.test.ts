// @vitest-environment node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseBunCanaryConfig,
	readBunCanaryConfig,
	repositoryRoot,
} from "./bun-toolchain";

const packageJson = JSON.parse(
	readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
) as { packageManager?: string };

describe("Bun canary toolchain", () => {
	it("parses strict data-only shell assignments", () => {
		expect(
			parseBunCanaryConfig("# comment\nVALUE='one'\nOTHER='two'\n"),
		).toEqual({ VALUE: "one", OTHER: "two" });
		expect(() => parseBunCanaryConfig("VALUE=unquoted\n")).toThrow(
			"Invalid Bun canary config line",
		);
	});

	it("keeps package metadata and platform digests aligned", () => {
		const config = readBunCanaryConfig();
		expect(packageJson.packageManager).toBe(
			`bun@${config.BUN_CANARY_REVISION}`,
		);
		expect(config.BUN_CANARY_SOURCE_SHA).toMatch(/^[0-9a-f]{40}$/);
		for (const key of [
			"BUN_CANARY_DARWIN_ARM64_ARCHIVE_SHA256",
			"BUN_CANARY_DARWIN_ARM64_BINARY_SHA256",
			"BUN_CANARY_LINUX_X64_ARCHIVE_SHA256",
			"BUN_CANARY_LINUX_X64_BINARY_SHA256",
		]) {
			expect(config[key]).toMatch(/^[0-9a-f]{64}$/);
		}
		for (const key of [
			"BUN_CANARY_DARWIN_ARM64_ARTIFACT_URL",
			"BUN_CANARY_LINUX_X64_ARTIFACT_URL",
		]) {
			expect(config[key]).toMatch(
				/^https:\/\/github\.com\/openclaw\/bun\/releases\/download\/openclaw-v[^/]+\/bun-(darwin-aarch64|linux-x64)\.zip$/,
			);
		}
	});

	it("ships executable fail-closed installer and runner scripts", () => {
		for (const relativePath of [
			"scripts/install-bun-canary.sh",
			"scripts/bun-canary.sh",
		]) {
			const filePath = path.join(repositoryRoot, relativePath);
			expect(statSync(filePath).mode & 0o111).not.toBe(0);
		}
		const installer = readFileSync(
			path.join(repositoryRoot, "scripts/install-bun-canary.sh"),
			"utf8",
		);
		expect(installer).toContain("archive checksum mismatch");
		expect(installer).toContain("BIRDCLAW_BUN_ARCHIVE");
		expect(
			readFileSync(path.join(repositoryRoot, "scripts/bun-canary.sh"), "utf8"),
		).toContain("--no-env-file");
		expect(existsSync(path.join(repositoryRoot, "pnpm-lock.yaml"))).toBe(false);
		expect(existsSync(path.join(repositoryRoot, "pnpm-workspace.yaml"))).toBe(
			false,
		);
	});
});
