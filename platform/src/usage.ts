import { query, queryOne } from "./db.ts";

/**
 * Per-user spend on the coding agent, in US dollars.
 *
 * Every assistant message the agent finishes is recorded with its token counts and cost.
 * A user's spend is the sum for the current calendar month (UTC), checked against their
 * monthly budget before each new prompt. Users marked unlimited are never blocked.
 */

interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface AssistantMessage {
	role?: string;
	model?: string;
	provider?: string;
	usage?: PiUsage;
}

// Fallback list prices in USD per million tokens [input, output, cache read, cache write], used only when
// pi reports no cost for a model (for example a model newer than its catalog). First match wins.
const PRICES: Array<[RegExp, [number, number, number, number]]> = [
	[/fable|mythos/, [10, 50, 1, 12.5]],
	[/opus-5-5|opus-5\.5/, [4, 20, 0.2, 5]],
	[/opus-4-[01]|opus-4$|opus-4-2025/, [15, 75, 1.5, 18.75]],
	[/opus/, [5, 25, 0.5, 6.25]],
	[/sonnet-5/, [2, 10, 0.2, 2.5]],
	[/sonnet/, [3, 15, 0.3, 3.75]],
	[/haiku-5/, [0.1, 0.5, 0.01, 0.125]],
	[/haiku/, [1, 5, 0.1, 1.25]],
];

export function costOf(model: string, usage: PiUsage): number {
	const reported = usage.cost?.total ?? 0;
	if (reported > 0) return reported;
	const price = PRICES.find(([pattern]) => pattern.test(model.toLowerCase()))?.[1];
	if (!price) return 0;
	const [input, output, cacheRead, cacheWrite] = price;
	return (
		((usage.input ?? 0) * input +
			(usage.output ?? 0) * output +
			(usage.cacheRead ?? 0) * cacheRead +
			(usage.cacheWrite ?? 0) * cacheWrite) /
		1_000_000
	);
}

export async function recordUsage(userId: string, projectId: string | null, message: AssistantMessage): Promise<void> {
	const usage = message.usage;
	if (!usage) return;
	const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (tokens === 0) return;
	const model = message.model ?? "";
	await query(
		`insert into usage_events (user_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
		 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[userId, projectId, model, usage.input ?? 0, usage.output ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, costOf(model, usage)],
	);
}

export interface UsageSummary {
	spentUsd: number;
	budgetUsd: number;
	unlimited: boolean;
	remainingUsd: number | null;
	periodStart: string;
	resetsAt: string;
}

const MONTH_START = "date_trunc('month', now() at time zone 'utc') at time zone 'utc'";

export async function usageFor(userId: string): Promise<UsageSummary> {
	const row = await queryOne<{ spent: string; budget: string; unlimited: boolean; start: Date; reset: Date }>(
		`select coalesce((select sum(cost_usd) from usage_events e where e.user_id = u.id and e.created_at >= ${MONTH_START}), 0)::text as spent,
		        u.monthly_budget_usd::text as budget, u.unlimited,
		        ${MONTH_START} as start, ${MONTH_START} + interval '1 month' as reset
		 from users u where u.id = $1`,
		[userId],
	);
	if (!row) throw new Error("User not found");
	const spentUsd = Number(row.spent);
	const budgetUsd = Number(row.budget);
	return {
		spentUsd,
		budgetUsd,
		unlimited: row.unlimited,
		remainingUsd: row.unlimited ? null : Math.max(0, budgetUsd - spentUsd),
		periodStart: row.start.toISOString(),
		resetsAt: row.reset.toISOString(),
	};
}

export class BudgetError extends Error {}

/** Throws when the user has used their whole monthly budget. A run already in progress is not stopped. */
export async function assertBudget(userId: string): Promise<void> {
	const usage = await usageFor(userId);
	if (usage.unlimited || usage.spentUsd < usage.budgetUsd) return;
	const resets = new Date(usage.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
	throw new BudgetError(
		`You have used your $${usage.budgetUsd.toFixed(2)} budget for this month. Ask an admin to raise it, or wait until it resets on ${resets}.`,
	);
}

/** This month's spend broken down by app and by day, for the usage page. */
export async function usageDetail(userId: string) {
	const [summary, byProject, byDay] = await Promise.all([
		usageFor(userId),
		query<{ project_id: string | null; name: string | null; cost: string; turns: string }>(
			`select e.project_id, p.name, sum(e.cost_usd)::text as cost, count(*)::text as turns
			 from usage_events e left join projects p on p.id = e.project_id
			 where e.user_id = $1 and e.created_at >= ${MONTH_START}
			 group by e.project_id, p.name order by sum(e.cost_usd) desc`,
			[userId],
		),
		query<{ day: string; cost: string }>(
			`select to_char(date_trunc('day', created_at at time zone 'utc'), 'YYYY-MM-DD') as day, sum(cost_usd)::text as cost
			 from usage_events where user_id = $1 and created_at >= ${MONTH_START}
			 group by 1 order by 1`,
			[userId],
		),
	]);
	return {
		...summary,
		byProject: byProject.map((r) => ({
			projectId: r.project_id,
			name: r.name ?? "Deleted app",
			costUsd: Number(r.cost),
			messages: Number(r.turns),
		})),
		byDay: byDay.map((r) => ({ day: r.day, costUsd: Number(r.cost) })),
	};
}

/** Every user with this month's spend, for the admin team page. */
export async function listUsersWithUsage() {
	const rows = await query<{
		id: string;
		email: string;
		name: string;
		role: string;
		created_at: Date;
		budget: string;
		unlimited: boolean;
		spent: string;
	}>(
		`select u.id, u.email, u.name, u.role, u.created_at, u.monthly_budget_usd::text as budget, u.unlimited,
		        coalesce(sum(e.cost_usd), 0)::text as spent
		 from users u left join usage_events e on e.user_id = u.id and e.created_at >= ${MONTH_START}
		 group by u.id order by u.created_at`,
	);
	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		name: r.name,
		role: r.role,
		createdAt: r.created_at,
		budgetUsd: Number(r.budget),
		unlimited: r.unlimited,
		spentUsd: Number(r.spent),
	}));
}

export function parseBudget(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new BudgetError("Budget must be a dollar amount of 0 or more");
	return Math.round(n * 100) / 100;
}

export async function setBudget(userId: string, budgetUsd: number | undefined, unlimited: boolean | undefined): Promise<void> {
	await query(
		`update users set monthly_budget_usd = coalesce($2, monthly_budget_usd), unlimited = coalesce($3, unlimited) where id = $1`,
		[userId, budgetUsd ?? null, unlimited ?? null],
	);
}
