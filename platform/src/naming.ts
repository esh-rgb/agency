import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockEnabled } from "./bedrock.ts";
import { config } from "./config.ts";
import { credentialsFromFile } from "./ecs.ts";
import { utilityModel } from "./models.ts";
import { slugify } from "./projects.ts";

/**
 * Names a new app from what its creator asked for.
 *
 * A small, fast Claude model reads the first prompt and answers with a short name in the prompt's
 * language and an English slug for the app's subdomain, so "דשבורד של עסקאות פתוחות" becomes
 * "דשבורד עסקאות" at open-deals.<domain>. A name the creator typed is kept; the model then only
 * picks the slug when the name has no Latin letters to make one from. Without a model (no key, a
 * non-Claude AGENCY_MODEL, an error or a slow answer) the app is named after the prompt's first words.
 */

export interface AppName {
	name: string;
	// Subdomain to start from; createProject adds -2, -3, ... when it is taken.
	slug: string;
	// What the naming call cost, recorded against the creator once the app exists.
	usage?: { model: string; usage: { input: number; output: number } };
}

const TIMEOUT_MS = 8000;

const INSTRUCTIONS = `You name internal web apps that a team member asked an AI to build.
Read the request and answer with JSON only, no other text: {"name": "...", "slug": "..."}
- name: what the app is, 1 to 4 words, in the same language as the request. Title case for English. No quotes, emoji or the word "app" unless it is needed.
- slug: 1 to 3 English words in lowercase, joined with hyphens, at most 30 characters, a-z, 0-9 and hyphens only. It becomes the app's web address, so make it short and clear, for example "open-deals" or "expense-log". Translate the idea to English when the request is in another language.
If you are given a name, keep it as the name and choose a slug that matches it.`;

const bedrock = bedrockEnabled
	? new BedrockRuntimeClient({ region: config.awsRegion, credentials: () => credentialsFromFile(config.awsCredentialsFile) })
	: undefined;

export async function nameApp(prompt: string, given = ""): Promise<AppName> {
	const fallbackName = given || prompt.split(/\s+/).slice(0, 4).join(" ").slice(0, 60) || "New app";
	if (given && slugify(given)) return { name: given, slug: slugify(given) };
	let usage: AppName["usage"];
	try {
		const answer = await askClaude(INSTRUCTIONS, given ? `Name: ${given}\n\nRequest:\n${prompt}` : prompt);
		if (answer) {
			usage = { model: answer.model, usage: answer.usage };
			const parsed = JSON.parse(/\{[\s\S]*\}/.exec(answer.text)?.[0] ?? "{}") as { name?: unknown; slug?: unknown };
			const name = given || (typeof parsed.name === "string" ? parsed.name.replace(/\s+/g, " ").trim().slice(0, 60) : "");
			const slug = typeof parsed.slug === "string" ? slugify(parsed.slug).slice(0, 30).replace(/-+$/, "") : "";
			if (name && slug) return { name, slug, usage };
		}
	} catch (error) {
		console.error(`[naming] couldn't name the app with a model: ${error instanceof Error ? error.message : error}`);
	}
	// A prompt with no Latin letters has nothing to make a subdomain from.
	return { name: fallbackName, slug: slugify(fallbackName) || "new-app", usage };
}

export interface Answer {
	text: string;
	model: string;
	usage: { input: number; output: number };
}

/**
 * Sends one message to the small, fast utility model, for the platform's own short jobs (naming apps,
 * organizing ideas); undefined when this deploy has no way to reach Claude.
 */
export async function askClaude(
	system: string,
	request: string,
	options: { maxTokens?: number; maxInput?: number; timeoutMs?: number } = {},
): Promise<Answer | undefined> {
	const model = utilityModel();
	const timeout = options.timeoutMs ?? TIMEOUT_MS;
	const body = { max_tokens: options.maxTokens ?? 200, system, messages: [{ role: "user", content: request.slice(0, options.maxInput ?? 4000) }] };
	let response: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
	if (bedrock) {
		const result = await bedrock.send(
			new InvokeModelCommand({ modelId: model, contentType: "application/json", body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...body }) }),
			{ abortSignal: AbortSignal.timeout(timeout) },
		);
		response = JSON.parse(new TextDecoder().decode(result.body));
	} else {
		const key = process.env.ANTHROPIC_API_KEY;
		// A deploy whose agent runs a non-Claude model (AGENCY_MODEL) may have no Claude key at all.
		if (!key) return undefined;
		const result = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
			method: "POST",
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
			body: JSON.stringify({ model, ...body }),
			signal: AbortSignal.timeout(timeout),
		});
		if (!result.ok) throw new Error(`Claude API answered ${result.status}: ${(await result.text()).slice(0, 200)}`);
		response = await result.json();
	}
	const text = (response.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
	return { text, model, usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 } };
}
