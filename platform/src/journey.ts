// The builder's journey: the stages an app goes through, shown above the chat so someone who has never
// built software knows what comes next. Describe (a written spec), Plan, Build, Check (the agent tests
// the app against the spec), Approve and Publish. The builder UI holds what each stage says and asks
// the agent; this module records who finished which stage, and which version was approved.
//
// The journey is a guide, not a gate, with one exception an admin can turn on: "approval before
// publish", where a version can only be published once an admin approved that exact version.

import { bridgeFor } from "./agent.ts";
import type { User } from "./auth.ts";
import { config } from "./config.ts";
import { query, queryOne } from "./db.ts";
import { sendMail } from "./mail.ts";
import type { Project } from "./projects.ts";
import { execArgv } from "./sandboxes.ts";
import { getSetting, putSetting } from "./settings.ts";

export const STAGES = ["describe", "plan", "build", "check", "approve"] as const;
export type Stage = (typeof STAGES)[number];

/** Thrown for problems the user caused (unknown stage, not allowed, not approved); the API answers with 400. */
export class JourneyError extends Error {}

interface JourneySettings {
	// Publishing needs an admin's approval of the exact version being published.
	requireApproval: boolean;
}

export async function journeySettings(): Promise<JourneySettings> {
	return { requireApproval: false, ...(await getSetting<JourneySettings>("journey")) };
}

export async function saveJourneySettings(body: { requireApproval?: unknown }): Promise<JourneySettings> {
	const settings = { requireApproval: body.requireApproval === true };
	await putSetting("journey", settings);
	return settings;
}

interface StageRow {
	stage: Stage;
	done: boolean;
	git_commit: string;
	created_at: string;
	email: string | null;
	name: string | null;
}

/** The latest event for each stage: whether it's done, by whom, when, and at which version. */
async function latestEvents(project: Project): Promise<Map<Stage, StageRow>> {
	const rows = await query<StageRow>(
		`select distinct on (e.stage) e.stage, e.done, e.git_commit, e.created_at, u.email, u.name
		 from journey_events e left join users u on u.id = e.user_id
		 where e.project_id = $1 order by e.stage, e.id desc`,
		[project.id],
	);
	return new Map(rows.map((row) => [row.stage, row]));
}

/** Short commit ids grow a character as a repository grows, so the same version can be spelled two ways. */
function sameCommit(a: string, b: string): boolean {
	return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

async function headCommit(project: Project): Promise<string> {
	const result = await execArgv(project, ["git", "rev-parse", "--short", "HEAD"]);
	return result.code === 0 ? result.stdout.toString().trim() : "";
}

/** True if someone changed files the agent hasn't committed yet, so HEAD isn't the whole app. */
async function uncommitted(project: Project): Promise<boolean> {
	const result = await execArgv(project, ["git", "status", "--porcelain"]);
	return result.code === 0 && result.stdout.toString().trim() !== "";
}

/** The version an admin (or, without required approval, the owner) approved for publishing, if any. */
async function approvedCommit(project: Project): Promise<string | null> {
	const row = await queryOne<{ done: boolean; git_commit: string }>(
		"select done, git_commit from journey_events where project_id = $1 and stage = 'approve' order by id desc limit 1",
		[project.id],
	);
	return row?.done && row.git_commit ? row.git_commit : null;
}

export async function journeyView(project: Project) {
	const [events, settings, head] = await Promise.all([latestEvents(project), journeySettings(), headCommit(project)]);
	const stages = Object.fromEntries(
		STAGES.map((stage) => {
			const row = events.get(stage);
			return [stage, row?.done ? { done: true, by: row.name || row.email, at: row.created_at, commit: row.git_commit } : { done: false }];
		}),
	);
	const approved = events.get("approve");
	return {
		stages,
		requireApproval: settings.requireApproval,
		// The app changed after it was approved: the approval no longer covers what would be published.
		approvalStale: Boolean(approved?.done && approved.git_commit && (!sameCommit(approved.git_commit, head) || (await uncommitted(project)))),
	};
}

/** Who may approve: admins when approval is required, otherwise the app's owner (admins are owners too). */
export async function canApprove(user: User, isOwner: boolean): Promise<boolean> {
	return (await journeySettings()).requireApproval ? user.role === "admin" : isOwner;
}

/**
 * Marks a stage done, or open again. Approving saves the current files as a version first and
 * records it, so the approval covers exactly what was approved.
 */
export async function setStage(project: Project, user: User, stage: string, done: boolean, isOwner: boolean): Promise<void> {
	if (!STAGES.includes(stage as Stage)) throw new JourneyError("Unknown stage");
	let commit = "";
	if (stage === "approve") {
		if (!(await canApprove(user, isOwner))) {
			throw new JourneyError(
				(await journeySettings()).requireApproval ? "Only an admin can approve an app for publishing" : "Only the app's owner or an admin can approve it",
			);
		}
		if (done) {
			const bridge = bridgeFor(project);
			if (bridge.running) throw new JourneyError("Wait for the agent to finish before approving");
			commit = await bridge.commit("Approved for publishing");
		}
	} else {
		commit = await headCommit(project);
	}
	await query("insert into journey_events (project_id, stage, done, git_commit, user_id) values ($1, $2, $3, $4, $5)", [
		project.id,
		stage,
		done,
		commit,
		user.id,
	]);
}

/** Called by publish with the version it is about to build. Throws unless approval is off or covers it. */
export async function assertApproved(project: Project, commit: string): Promise<void> {
	if (!(await journeySettings()).requireApproval) return;
	const approved = await approvedCommit(project);
	if (!approved) throw new JourneyError("An admin needs to approve this app before it can be published. Use Ask for approval in the journey.");
	if (!sameCommit(approved, commit)) {
		throw new JourneyError("The app changed after it was approved. An admin needs to approve this version before it can be published.");
	}
}

/** Emails every admin that someone asks them to approve an app. Returns how many were asked. */
export async function requestApproval(project: Project, user: User, note: string): Promise<number> {
	if (await uncommitted(project)) await bridgeFor(project).commit("Ready for approval");
	const admins = await query<{ email: string; name: string }>("select email, name from users where role = 'admin' and id <> $1", [user.id]);
	const who = user.name || user.email;
	const url = `${config.publicUrl}/#/p/${project.id}`;
	let sent = 0;
	for (const admin of admins) {
		const ok = await sendMail({
			to: admin.email,
			subject: `${who} asks you to approve ${project.name}`,
			text: [
				`Hi ${admin.name || admin.email},`,
				"",
				`${who} finished building ${project.name} and asks you to approve it for publishing.`,
				...(note ? ["", `Their note: ${note}`] : []),
				"",
				`Open it in Agency to try the preview, read the spec and the checks, and approve it under the journey above the chat: ${url}`,
				"",
				"Agency",
			].join("\n"),
		}).catch(() => false);
		if (ok) sent++;
	}
	return sent;
}
