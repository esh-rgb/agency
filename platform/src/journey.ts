// The builder's journey: the stages an app goes through, shown above the chat so someone who has never
// built software knows what comes next. Describe (a written spec), Plan, Build, Check (the agent tests
// the app against the spec), Approve and Publish. The builder UI holds what each stage says and asks
// the agent; this module records who finished which stage.
//
// The journey is a guide, not a gate, with one exception an admin can turn on: approval before
// publishing to the whole organization. The admin runs the platform rather than building on it, and
// decides what goes live; to keep that from becoming a bottleneck:
// - the risk comes from who the app is shared with: an app shared only with named people (a team)
//   needs no approval, one the whole organization can open does;
// - only the first publish at a level needs approval: updates go out without asking again, unless
//   the app is shared more widely than what was approved;
// - the agent writes a short justification (JUSTIFICATION.md) that goes with each request;
// - requests wait in one queue for the admins (Approvals), and both sides get an email.

import type { User } from "./auth.ts";
import { config } from "./config.ts";
import { query, queryOne } from "./db.ts";
import { readFile } from "./files.ts";
import { sendMail } from "./mail.ts";
import type { Project } from "./projects.ts";
import { getSetting, putSetting } from "./settings.ts";

export const STAGES = ["describe", "plan", "build", "check", "approve"] as const;
export type Stage = (typeof STAGES)[number];

/** Who an app is for, from least to most risky. "external" is declared by the builder for apps meant for people outside the organization. */
export const AUDIENCES = ["team", "org", "external"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Thrown for problems the user caused (unknown stage, not allowed, not approved); the API answers with 400. */
export class JourneyError extends Error {}

interface JourneySettings {
	// Publishing an app the whole organization can open needs an admin's approval, once per level.
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

function rank(audience: Audience): number {
	return AUDIENCES.indexOf(audience);
}

/** The level the app's sharing puts it at: a team when only named people have it, the organization otherwise. */
export function sharedAudience(project: Project): Audience {
	return project.team_access === "none" ? "team" : "org";
}

interface StageRow {
	stage: Stage;
	done: boolean;
	created_at: string;
	email: string | null;
	name: string | null;
}

/** The latest event for each stage: whether it's done, by whom and when. */
async function latestEvents(project: Project): Promise<Map<Stage, StageRow>> {
	const rows = await query<StageRow>(
		`select distinct on (e.stage) e.stage, e.done, e.created_at, u.email, u.name
		 from journey_events e left join users u on u.id = e.user_id
		 where e.project_id = $1 order by e.stage, e.id desc`,
		[project.id],
	);
	return new Map(rows.map((row) => [row.stage, row]));
}

export interface ApprovalRequest {
	id: number;
	project_id: string;
	audience: Audience;
	justification: string;
	note: string;
	status: "pending" | "approved" | "declined" | "revoked";
	decision_note: string;
	created_at: string;
	decided_at: string | null;
	requested_by_name: string | null;
	decided_by_name: string | null;
}

const REQUEST_COLUMNS = `r.id, r.project_id, r.audience, r.justification, r.note, r.status, r.decision_note, r.created_at, r.decided_at,
	coalesce(nullif(a.name, ''), a.email) as requested_by_name, coalesce(nullif(d.name, ''), d.email) as decided_by_name`;
const REQUEST_JOINS = "left join users a on a.id = r.requested_by left join users d on d.id = r.decided_by";

async function latestRequest(project: Project): Promise<ApprovalRequest | undefined> {
	return queryOne<ApprovalRequest>(`select ${REQUEST_COLUMNS} from approval_requests r ${REQUEST_JOINS} where r.project_id = $1 order by r.id desc limit 1`, [
		project.id,
	]);
}

/** The widest level an admin approved for the app and hasn't revoked, if any. */
async function approvedAudience(project: Project): Promise<Audience | null> {
	const rows = await query<{ audience: Audience }>("select audience from approval_requests where project_id = $1 and status = 'approved'", [project.id]);
	if (rows.length === 0) return null;
	return rows.map((r) => r.audience).reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

/** What publishing needs right now: nothing, or an admin's approval at `needed`. */
async function approvalNeeded(project: Project): Promise<{ needed: Audience | null; approved: Audience | null }> {
	const approved = await approvedAudience(project);
	if (!(await journeySettings()).requireApproval) return { needed: null, approved };
	const audience = sharedAudience(project);
	if (audience === "team") return { needed: null, approved };
	return { needed: approved && rank(approved) >= rank(audience) ? null : audience, approved };
}

export async function journeyView(project: Project, user: User, isOwner: boolean) {
	const [events, settings, latest, gate] = await Promise.all([latestEvents(project), journeySettings(), latestRequest(project), approvalNeeded(project)]);
	const stages: Record<string, { done: boolean; by?: string | null; at?: string | null }> = Object.fromEntries(
		STAGES.map((stage) => {
			const row = events.get(stage);
			return [stage, row?.done ? { done: true, by: row.name || row.email, at: row.created_at } : { done: false }];
		}),
	);
	// With approval required, Approve is done once nothing more is needed to publish at the app's level.
	if (settings.requireApproval) {
		stages.approve = gate.needed ? { done: false } : { done: true, by: latest?.status === "approved" ? latest.decided_by_name : null, at: latest?.decided_at ?? null };
	}
	return {
		stages,
		requireApproval: settings.requireApproval,
		audience: sharedAudience(project),
		approvalNeeded: gate.needed,
		approvedAudience: gate.approved,
		request: latest ?? null,
		canMarkApprove: !settings.requireApproval && isOwner,
		isAdmin: user.role === "admin",
	};
}

/** Marks a stage done, or open again. With approval required, Approve follows the admins' decisions instead. */
export async function setStage(project: Project, user: User, stage: string, done: boolean, isOwner: boolean): Promise<void> {
	if (!STAGES.includes(stage as Stage)) throw new JourneyError("Unknown stage");
	if (stage === "approve") {
		if ((await journeySettings()).requireApproval) throw new JourneyError("An admin approves this app from the Approvals queue");
		if (!isOwner) throw new JourneyError("Only the app's owner or an admin can mark it approved");
	}
	await query("insert into journey_events (project_id, stage, done, user_id) values ($1, $2, $3, $4)", [project.id, stage, done, user.id]);
}

/** Called by publish before it builds. Throws when the app's level needs an approval it doesn't have. */
export async function assertApproved(project: Project): Promise<void> {
	const { needed, approved } = await approvalNeeded(project);
	if (!needed) return;
	if (approved) {
		throw new JourneyError(
			"The app is now shared with the whole organization, more widely than an admin approved. Ask for approval again, or share it only with named people.",
		);
	}
	throw new JourneyError(
		"Publishing to the whole organization needs an admin's approval first. Ask for approval in the journey, or share the app only with named people.",
	);
}

/**
 * Called before an app's sharing changes. A live app shared with a team can't be opened to the whole
 * organization until an admin approves it; before it's published, sharing is how people build together.
 */
export async function assertCanShare(project: Project, teamAccess: string): Promise<void> {
	if (teamAccess === "none" || !(await journeySettings()).requireApproval) return;
	const live = await queryOne("select 1 from deployments where project_id = $1 and active", [project.id]);
	if (!live) return;
	const approved = await approvedAudience(project);
	if (approved && rank(approved) >= rank("org")) return;
	throw new JourneyError("This app is live. Sharing it with the whole organization needs an admin's approval first: ask for it in the journey's Approve stage.");
}

async function admins(except: string): Promise<{ email: string; name: string }[]> {
	return query<{ email: string; name: string }>("select email, name from users where role = 'admin' and id <> $1", [except]);
}

async function mailQuietly(to: string, subject: string, lines: string[]): Promise<boolean> {
	return sendMail({ to, subject, text: lines.join("\n") }).catch(() => false);
}

const AUDIENCE_WORDS: Record<Audience, string> = { team: "a team", org: "the whole organization", external: "people outside the organization" };

/**
 * Files a request for an admin to approve the app at `audience`, with a copy of JUSTIFICATION.md as it is
 * now, and emails the admins. A pending request for the app is replaced.
 */
export async function requestApproval(project: Project, user: User, body: { audience?: string; note?: string }): Promise<ApprovalRequest> {
	const audience = (AUDIENCES as readonly string[]).includes(String(body.audience)) ? (body.audience as Audience) : sharedAudience(project);
	const note = String(body.note ?? "").trim().slice(0, 1000);
	const file = await readFile(project, "JUSTIFICATION.md").catch(() => null);
	const justification = file && "content" in file ? file.content.slice(0, 20_000) : "";
	if (!justification.trim()) throw new JourneyError("Ask the agent to prepare the justification first. It goes with the request.");
	await query("update approval_requests set status = 'declined', decision_note = 'Replaced by a newer request', decided_at = now() where project_id = $1 and status = 'pending'", [
		project.id,
	]);
	const row = await queryOne<{ id: number }>(
		"insert into approval_requests (project_id, requested_by, audience, justification, note) values ($1, $2, $3, $4, $5) returning id",
		[project.id, user.id, audience, justification, note],
	);
	const who = user.name || user.email;
	for (const admin of await admins(user.id)) {
		await mailQuietly(admin.email, `${who} asks you to approve ${project.name}`, [
			`Hi ${admin.name || admin.email},`,
			"",
			`${who} asks you to approve ${project.name} for ${AUDIENCE_WORDS[audience]}.`,
			...(note ? ["", `Their note: ${note}`] : []),
			"",
			`The justification, the spec and the checks are waiting in Approvals: ${config.publicUrl}/#/approvals`,
			"",
			"Agency",
		]);
	}
	return (await queryOne<ApprovalRequest>(`select ${REQUEST_COLUMNS} from approval_requests r ${REQUEST_JOINS} where r.id = $1`, [row!.id]))!;
}

export interface QueueItem extends ApprovalRequest {
	project_name: string;
	project_slug: string;
}

/** The admins' queue: pending requests first (oldest first), then the latest 30 decisions. */
export async function approvalQueue(): Promise<{ pending: QueueItem[]; decided: QueueItem[] }> {
	const select = `select ${REQUEST_COLUMNS}, p.name as project_name, p.slug as project_slug
		from approval_requests r join projects p on p.id = r.project_id ${REQUEST_JOINS}`;
	const [pending, decided] = await Promise.all([
		query<QueueItem>(`${select} where r.status = 'pending' order by r.id`),
		query<QueueItem>(`${select} where r.status <> 'pending' order by r.decided_at desc nulls last limit 30`),
	]);
	return { pending, decided };
}

export async function countPending(): Promise<number> {
	const row = await queryOne<{ count: string }>("select count(*) from approval_requests where status = 'pending'");
	return Number(row?.count ?? 0);
}

/** An admin approves or declines a pending request, or revokes an approval; the requester gets an email. */
export async function decide(id: number, admin: User, body: { decision?: string; note?: string }): Promise<void> {
	const decision = body.decision;
	if (decision !== "approved" && decision !== "declined" && decision !== "revoked") throw new JourneyError("Approve, decline or revoke");
	const note = String(body.note ?? "").trim().slice(0, 1000);
	if (decision !== "approved" && !note) throw new JourneyError("Say why, so the builder knows what to change");
	const current = await queryOne<{ status: string; project_id: string; requested_by: string; audience: Audience }>(
		"select status, project_id, requested_by, audience from approval_requests where id = $1",
		[id],
	);
	if (!current) throw new JourneyError("Request not found");
	const allowed = decision === "revoked" ? current.status === "approved" : current.status === "pending";
	if (!allowed) throw new JourneyError(decision === "revoked" ? "Only an approval can be revoked" : "This request was already decided");
	await query("update approval_requests set status = $2, decision_note = $3, decided_by = $4, decided_at = now() where id = $1", [id, decision, note, admin.id]);
	const [project, requester] = await Promise.all([
		queryOne<{ name: string }>("select name from projects where id = $1", [current.project_id]),
		queryOne<{ email: string; name: string }>("select email, name from users where id = $1", [current.requested_by]),
	]);
	if (!project || !requester) return;
	const words = { approved: "approved", declined: "didn't approve", revoked: "revoked the approval of" }[decision];
	await mailQuietly(requester.email, `${admin.name || admin.email} ${words} ${project.name}`, [
		`Hi ${requester.name || requester.email},`,
		"",
		decision === "approved"
			? `${project.name} is approved for ${AUDIENCE_WORDS[current.audience]}. You can publish it now, and later updates go out without asking again.`
			: decision === "declined"
				? `${project.name} wasn't approved for ${AUDIENCE_WORDS[current.audience]} yet.`
				: `The approval of ${project.name} was revoked. What is live stays live, but it can't be published again until it's approved.`,
		...(note ? ["", `${admin.name || admin.email} wrote: ${note}`] : []),
		"",
		`Open it in Agency: ${config.publicUrl}/#/p/${current.project_id}`,
		"",
		"Agency",
	]);
}
