import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const TOKEN_SERVICE = "pi-slack-bot-token";

export interface TokenCommand {
	command: string;
	args: string[];
	store: string;
}

function defaultAccount(): string {
	return process.env.USER || process.env.LOGNAME || userInfo().username;
}

/** Returns the OS credential-store command that prints the Slack bot token. */
export function tokenCommand(
	platform: NodeJS.Platform = process.platform,
	account: string = defaultAccount(),
	home: string = homedir(),
): TokenCommand {
	if (platform === "darwin") {
		return {
			command: "/usr/bin/security",
			args: [
				"find-generic-password",
				"-s",
				TOKEN_SERVICE,
				"-w",
				join(home, "Library/Keychains/login.keychain-db"),
			],
			store: "macOS login Keychain",
		};
	}

	if (platform === "linux") {
		return {
			command: "secret-tool",
			args: ["lookup", "service", TOKEN_SERVICE, "account", account],
			store: "Linux Secret Service (secret-tool)",
		};
	}

	throw new Error(`The Slack bot token cannot be read on unsupported platform ${platform}.`);
}

function setupHint(platform: NodeJS.Platform, account: string): string {
	if (platform === "linux") {
		return `Store it with: secret-tool store --label='Slack bot token' service ${TOKEN_SERVICE} account ${account}`;
	}
	return `Approve the Keychain prompt and confirm that service ${TOKEN_SERVICE} exists.`;
}

export function getBotToken(
	signal?: AbortSignal,
	platform: NodeJS.Platform = process.platform,
	account: string = defaultAccount(),
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, token?: string) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(token ?? "");
		};

		let spec: TokenCommand;
		try {
			spec = tokenCommand(platform, account);
		} catch (error) {
			reject(error);
			return;
		}

		const child = execFile(
			spec.command,
			spec.args,
			{ encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 },
			(error, stdout) => {
				if (error) {
					finish(
						new Error(
							`Could not retrieve the Slack bot token from the ${spec.store}. ${setupHint(platform, account)}`,
						),
					);
					return;
				}

				const token = stdout.trim();
				if (!token) {
					finish(new Error(`The Slack bot token in the ${spec.store} is empty.`));
					return;
				}
				finish(undefined, token);
			},
		);

		const onAbort = () => {
			child.kill();
			finish(new Error("Slack operation cancelled."));
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}
