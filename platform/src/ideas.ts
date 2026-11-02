// Ideas: the organization's pipeline from "it would be great if..." to an app. Anyone writes an idea
// in plain words, or suggests an improvement from inside a published app; the agent organizes it (a
// title, the problem, who has it, what it would save) and points out similar ideas and existing apps.
// People vote and offer to build. Admins, who run the platform rather than build on it, merge
// duplicates, connect builders and turn an idea into an app: the builder gets a new app whose agent
// starts by writing the spec from the idea. An improvement goes to its app's chat as a plan to approve.

import type { User } from "./auth.ts";
import { bridgeFor } from "./agent.ts";
import { config } from "./config.ts";
import { query, queryOne } from "./db.ts";
import { sendMail } from "./mail.ts";
import { askClaude } from "./naming.ts";
import { createProject, getProject, type Project } from "./projects.ts";
import { assertBudget, recordUsage } from "./usage.ts";

/** Thrown for problems the user caused (empty idea, not allowed, wrong state); the API answers with 400. */
export class IdeaError extends Error {}

export const STATUSES = ["open", "planned", "building", "done", "declined", "merged"] as const;
export type IdeaStatus = (typeof STATUSES)[number];

interface IdeaRow {
	id: number;
	author_id: string | null;
	text: string;
	title: string;
	problem: string;
	who: string;
	value: string;
	similar: number[];
	similar_apps: string[];
	app_id: string | null;
	project_id: string | null;
	status: IdeaStatus;
	merged_into: number | null;
	admin_note: string;
	created_at: string;
}

const ORGANIZE = `You help an organization collect ideas for internal tools. A team member wrote an idea in plain words; organize it so others can understand and vote on it.
Answer with JSON only, no other text:
{"title": "...", "problem": "...", "who": "...", "value": "...", "similar": [ids], "similar_apps": ["app names"]}
- Write in the same language as the idea, in short plain sentences. Don't invent facts; leave a field empty if the idea doesn't say.
- title: what the tool would be, 3 to 8 words.
- problem: the problem today, one or two sentences.
- who: who has the problem and would use the tool.
- value: what it would save or improve (time, money, mistakes), as the idea says or as a cautious guess marked as one.
- similar: ids of the listed open ideas that ask for the same thing or overlap a lot (at most 3, often none).
- similar_apps: names of the listed existing apps that may already do this or could be extended instead (at most 3, often none).
If the idea is an improvement to a named app, organize it as a change to that app.`;

/** Asks the utility model to organize an idea; without a model the first words become the title. */
async function organize(text: string, author: User, app: Project | undefined) {
	const [openIdeas, apps] = await Promise.all([
		query<{ id: number; title: string }>("select id, title from ideas where status in ('open', 'planned', 'building') order by id desc limit 200"),
		query<{ name: string }>("select name from projects order by created_at desc limit 200"),
	]);
	const context = [
		app ? `This is a suggested improvement to the app "${app.name}".` : "",
		`Open ideas:\n${openIdeas.map((i) => `${i.id}: ${i.title}`).join("\n") || "(none)"}`,
		`Existing apps:\n${apps.map((a) => a.name).join("\n") || "(none)"}`,
		`The idea:\n${text}`,
	].join("\n\n");
	const fallback = { title: text.replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ").slice(0, 80), problem: "", who: "", value: "", similar: [] as number[], similar_apps: [] as string[] };
	try {
		const answer = await askClaude(ORGANIZE, context, { maxTokens: 600, maxInput: 16_000, timeoutMs: 20_000 });
		if (!answer) return fallback;
		await recordUsage(author.id, app?.id ?? null, { model: answer.model, usage: answer.usage }).catch(() => {});
		const parsed = JSON.parse(/\{[\s\S]*\}/.exec(answer.text)?.[0] ?? "{}") as Record<string, unknown>;
		const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
		const ids = new Set(openIdeas.map((i) => i.id));
		const names = new Set(apps.map((a) => a.name));
		return {
			title: str(parsed.title, 120) || fallback.title,
			problem: str(parsed.problem, 600),
			who: str(parsed.who, 300),
			value: str(parsed.value, 400),
			similar: (Array.isArray(parsed.similar) ? parsed.similar : []).map(Number).filter((id) => ids.has(id)).slice(0, 3),
			similar_apps: (Array.isArray(parsed.similar_apps) ? parsed.similar_apps : []).map(String).filter((n) => names.has(n)).slice(0, 3),
		};
	} catch (error) {
		console.error(`[ideas] couldn't organize an idea with a model: ${error instanceof Error ? error.message : error}`);
		return fallback;
	}
}

async function mailQuietly(to: string, subject: string, lines: string[]): Promise<void> {
	await sendMail({ to, subject, text: lines.join("\n") }).catch(() => false);
}

/** Files an idea, organized by the agent. With `appSlug` it's an improvement to that app, and its owner hears about it. */
export async function createIdea(author: User, body: { text?: string; app?: string }): Promise<number> {
	const text = String(body.text ?? "").trim().slice(0, 5000);
	if (text.length < 5) throw new IdeaError("Write the idea in a sentence or two");
	const app = body.app ? await queryOne<Project>("select * from projects where slug = $1 or id::text = $1", [String(body.app)]) : undefined;
	const organized = await organize(text, author, app);
	const row = await queryOne<{ id: number }>(
		`insert into ideas (author_id, text, title, problem, who, value, similar, similar_apps, app_id)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
		[author.id, text, organized.title, organized.problem, organized.who, organized.value, organized.similar, organized.similar_apps, app?.id ?? null],
	);
	if (app && app.owner_id !== author.id) {
		const owner = await queryOne<{ email: string; name: string }>("select email, name from users where id = $1", [app.owner_id]);
		if (owner) {
			await mailQuietly(owner.email, `${author.name || author.email} suggests an improvement to ${app.name}`, [
				`Hi ${owner.name || owner.email},`,
				"",
				`${author.name || author.email} suggests an improvement to ${app.name}:`,
				"",
				organized.title,
				text,
				"",
				`See it, and send it to the app's chat as a plan, in Ideas: ${config.publicUrl}/#/ideas`,
				"",
				"Agency",
			]);
		}
	}
	return row!.id;
}

/** Every idea with its votes, builders, author and the apps it belongs to, newest and most wanted first. */
export async function listIdeas(user: User) {
	const rows = await query<
		IdeaRow & { author_name: string | null; votes: number; voted: boolean; builders: { id: string; name: string }[]; app_name: string | null; app_owner: string | null; project_name: string | null }
	>(
		`select i.*, coalesce(nullif(a.name, ''), a.email) as author_name,
			(select count(*)::int from idea_votes v where v.idea_id = i.id) as votes,
			exists (select 1 from idea_votes v where v.idea_id = i.id and v.user_id = $1) as voted,
			coalesce((select json_agg(json_build_object('id', u.id, 'name', coalesce(nullif(u.name, ''), u.email)) order by b.created_at)
				from idea_builders b join users u on u.id = b.user_id where b.idea_id = i.id), '[]') as builders,
			ap.name as app_name, ap.owner_id as app_owner, pr.name as project_name
		 from ideas i
		 left join users a on a.id = i.author_id
		 left join projects ap on ap.id = i.app_id
		 left join projects pr on pr.id = i.project_id
		 order by (i.status in ('open', 'planned', 'building')) desc, votes desc, i.id desc`,
		[user.id],
	);
	const titles = new Map(rows.map((r) => [r.id, r.title]));
	return rows.map((r) => ({
		id: r.id,
		text: r.text,
		title: r.title,
		problem: r.problem,
		who: r.who,
		value: r.value,
		status: r.status,
		adminNote: r.admin_note,
		createdAt: r.created_at,
		author: r.author_name,
		mine: r.author_id === user.id,
		votes: r.votes,
		voted: r.voted,
		builders: r.builders,
		building: r.builders.some((b) => b.id === user.id),
		app: r.app_id ? { id: r.app_id, name: r.app_name, canPlan: user.role === "admin" || r.app_owner === user.id } : null,
		project: r.project_id ? { id: r.project_id, name: r.project_name } : null,
		mergedInto: r.merged_into ? { id: r.merged_into, title: titles.get(r.merged_into) ?? "" } : null,
		similar: r.similar.filter((id) => titles.has(id) && id !== r.id).map((id) => ({ id, title: titles.get(id)! })),
		similarApps: r.similar_apps,
	}));
}

async function getIdea(id: number): Promise<IdeaRow> {
	const idea = await queryOne<IdeaRow>("select * from ideas where id = $1", [id]);
	if (!idea) throw new IdeaError("Idea not found");
	return idea;
}

/** Votes for an idea, or takes the vote back. */
export async function toggleVote(id: number, user: User): Promise<void> {
	await getIdea(id);
	const removed = await query("delete from idea_votes where idea_id = $1 and user_id = $2 returning 1", [id, user.id]);
	if (removed.length === 0) await query("insert into idea_votes (idea_id, user_id) values ($1, $2) on conflict do nothing", [id, user.id]);
}

/** Offers to build an idea (or help), or withdraws the offer; admins see who offered. */
export async function toggleBuilder(id: number, user: User): Promise<void> {
	await getIdea(id);
	const removed = await query("delete from idea_builders where idea_id = $1 and user_id = $2 returning 1", [id, user.id]);
	if (removed.length === 0) await query("insert into idea_builders (idea_id, user_id) values ($1, $2) on conflict do nothing", [id, user.id]);
}

/** Admins set an idea's status and a note for everyone; the author may withdraw their own idea. */
export async function updateIdea(id: number, user: User, body: { status?: string; note?: string }): Promise<void> {
	const idea = await getIdea(id);
	const status = body.status === undefined ? idea.status : String(body.status);
	if (!(STATUSES as readonly string[]).includes(status) || status === "merged") throw new IdeaError("Unknown status");
	const admin = user.role === "admin";
	if (!admin && !(idea.author_id === user.id && status === "declined" && body.note === undefined)) throw new IdeaError("Only an admin can change this idea");
	const note = body.note === undefined ? idea.admin_note : String(body.note).trim().slice(0, 1000);
	await query("update ideas set status = $2, admin_note = $3, updated_at = now() where id = $1", [id, status, note]);
}

/** Admins merge a duplicate into another idea: its votes, builders and text move there. */
export async function mergeIdea(id: number, into: number): Promise<void> {
	if (id === into) throw new IdeaError("Pick a different idea to merge into");
	const [idea, target] = [await getIdea(id), await getIdea(into)];
	if (target.status === "merged") throw new IdeaError("That idea was merged into another one");
	await query("insert into idea_votes (idea_id, user_id) select $2, user_id from idea_votes where idea_id = $1 on conflict do nothing", [id, into]);
	await query("insert into idea_builders (idea_id, user_id) select $2, user_id from idea_builders where idea_id = $1 on conflict do nothing", [id, into]);
	await query("update ideas set text = text || $2, updated_at = now() where id = $1", [into, `\n\n---\n${idea.text}`]);
	await query("update ideas set status = 'merged', merged_into = $2, updated_at = now() where id = $1", [id, into]);
}

function ideaBrief(idea: IdeaRow): string {
	return [
		idea.title,
		idea.problem && `Problem: ${idea.problem}`,
		idea.who && `Who: ${idea.who}`,
		idea.value && `Value: ${idea.value}`,
		"",
		"In their words:",
		idea.text,
	]
		.filter((line) => line !== "")
		.join("\n");
}

/**
 * Admins turn a new-tool idea into an app owned by the builder they pick (often someone who offered),
 * whose agent starts by writing the spec from the idea and asking what it doesn't say.
 */
export async function startApp(id: number, admin: User, body: { builderId?: string }): Promise<Project> {
	const idea = await getIdea(id);
	if (idea.app_id) throw new IdeaError("This is an improvement to an existing app: send it to that app's chat instead");
	if (idea.project_id) throw new IdeaError("An app was already started from this idea");
	const builderId = String(body.builderId ?? admin.id);
	const builder = await queryOne<{ id: string; email: string; name: string }>("select id, email, name from users where id = $1", [builderId]);
	if (!builder) throw new IdeaError("Pick someone to build it");
	await assertBudget(builder.id);
	const project = await createProject(idea.title.slice(0, 60), builder.id, idea.title);
	await query("update ideas set project_id = $2, status = 'building', updated_at = now() where id = $1", [id, project.id]);
	const prompt = `This app starts from an idea someone in the organization wrote:\n\n${ideaBrief(idea)}\n\nBefore building, write SPEC.md at the project root in plain language: who will use the app and why, what they need to see and do, which of the organization's data it uses, the rules it must follow, and what is out of scope. Ask me, a few at a time, about anything the idea doesn't say. Don't build the app yet.`;
	bridgeFor(project)
		.prompt(prompt, builder.id)
		.catch((error) => console.error(`[ideas] first prompt for ${project.slug} failed: ${error instanceof Error ? error.message : error}`));
	if (builder.id !== admin.id) {
		await mailQuietly(builder.email, `You're building ${idea.title}`, [
			`Hi ${builder.name || builder.email},`,
			"",
			`${admin.name || admin.email} started an app from the idea "${idea.title}" and asked you to build it.`,
			"The agent is already writing the spec from the idea and will ask you about anything it doesn't say.",
			"",
			`Open it in Agency: ${config.publicUrl}/#/p/${project.id}`,
			"",
			"Agency",
		]);
	}
	return project;
}

/** The app's owner (or an admin) sends an improvement to the app's chat in Plan mode, to approve before building. */
export async function planImprovement(id: number, user: User): Promise<Project> {
	const idea = await getIdea(id);
	if (!idea.app_id) throw new IdeaError("This idea isn't about an existing app");
	const app = await getProject(idea.app_id);
	if (!app) throw new IdeaError("The app was deleted");
	if (user.role !== "admin" && app.owner_id !== user.id) throw new IdeaError("Only the app's owner or an admin can do this");
	await assertBudget(user.id);
	await bridgeFor(app).prompt(`Someone using the app suggested an improvement:\n\n${ideaBrief(idea)}\n\nPropose how to do it.`, user.id, [], { mode: "plan" });
	await query("update ideas set status = 'building', project_id = $2, updated_at = now() where id = $1", [id, app.id]);
	return app;
}
