import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { type AgentEvent, bridgeFor, CHAT_MODES, type ChatMode, dropBridge } from "./agent.ts";
import { type Attachment, checkAttachments, modelImages, promptWithAttachments, saveAttachments } from "./attachments.ts";
import { AccessError, assertRole, atLeast, getSharing, type ProjectRole, projectRole, setMember, setTeamAccess, slugFromHost, visibleProjects } from "./access.ts";
import { closeDataPools, DataError, deleteRow, insertRow, listTables, readRows, runSql, updateRow } from "./appdata.ts";
import { startAppIdleSweeper, wakeApp } from "./app-idle.ts";
import { appRuntime } from "./apps.ts";
import { bedrockApp } from "./bedrock.ts";
import {
	type AppEnv,
	createUser,
	currentUser,
	ensureAdmin,
	login,
	LoginError,
	loginWithSso,
	logout,
	requireAdmin,
	requireUser,
	RoleError,
	safeNext,
	setRole,
	type User,
	verifyForwardAuth,
} from "./auth.ts";
import { appHost, config, previewHost } from "./config.ts";
import { startIdleSweeper, touch, wake, watch } from "./idle.ts";
import { STARTING_HEADER, startingPage } from "./starting.ts";
import { canSendMail, MailError, mailView, removeSmtp, saveSmtp, sendMail } from "./mail.ts";
import {
	CONNECTION_KINDS,
	type ConnectionConfig,
	type ConnectionKind,
	createConnection,
	deleteConnection,
	finishSignIn,
	listConnections,
	setConnectionProjects,
	signOut,
	startSignIn,
	testConnection,
} from "./connectors.ts";
import { migrate, query } from "./db.ts";
import { execIn, sandboxes } from "./sandboxes.ts";
import { FileError, listFiles, readFile, writeFile } from "./files.ts";
import { gateway, mcpApp } from "./gateway.ts";
import {
	createProject,
	type DataEnv,
	deleteProject,
	ensureSandbox,
	getProject,
	getProjectBySlug,
	listProjects,
	type Project,
	renameProject,
	sandboxOutdated,
} from "./projects.ts";
import {
	autoPush,
	appManifestPage,
	finishAppInstall,
	finishAppManifest,
	getGitHub,
	linkNewApp,
	newAppsDefaults,
	saveNewAppsDefaults,
	GitHubError,
	gitHubView,
	linkRepository,
	projectGitHub,
	pushToGitHub,
	removeGitHub,
	saveGitHub,
	setAutoPush,
	unlinkRepository,
} from "./github.ts";
import { allowedModels, ModelError, modelSettings, saveModelSettings } from "./models.ts";
import { nameApp } from "./naming.ts";
import { listDeployments, publish, rollback, unpublish } from "./publish.ts";
import { promptWithSelection, selectionContext } from "./selection.ts";
import {
	createSkill,
	deleteSkill,
	getSkill,
	importFromGitHub,
	importUpload,
	listSkills,
	type Owner,
	refreshSkill,
	SKILL_TEMPLATE,
	SkillError,
	updateSkill,
} from "./skills.ts";
import { canApprove, JourneyError, journeySettings, journeyView, requestApproval, saveJourneySettings, setStage } from "./journey.ts";
import { saveSso, signInOptions, SsoError, ssoFinish, ssoStartUrl, ssoView } from "./sso.ts";
import { assertBudget, BudgetError, listUsersWithUsage, parseBudget, recordUsage, setBudget, usageDetail, usageFor } from "./usage.ts";

class NotFoundError extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function projectView(project: Project, role: ProjectRole | null) {
	const [sandbox, app, deployments] = await Promise.all([
		sandboxes.state(project),
		appRuntime.running(project),
		listDeployments(project),
	]);
	const active = deployments.find((d) => d.active);
	const asleep = Boolean(active && project.app_asleep_since && !app);
	return {
		id: project.id,
		slug: project.slug,
		name: project.name,
		createdAt: project.created_at,
		previewUrl: `${config.scheme}://${previewHost(project.slug)}`,
		appUrl: `${config.scheme}://${appHost(project.slug)}`,
		sandbox,
		published: active && (app || asleep) ? active.version : null,
		// Taken down after days without visits; its next visit starts it again.
		appAsleepSince: asleep ? project.app_asleep_since : null,
		liveDatabase: Boolean(project.live_db_name),
		agentRunning: bridgeFor(project).running,
		role,
		teamAccess: project.team_access,
	};
}

const app = new Hono<AppEnv>();

app.onError((error, c) => {
	// 402: the user's monthly agent budget is used up.
	if (error instanceof BudgetError) return c.json({ error: error.message, code: "budget" }, 402);
	if (error instanceof DataError) return c.json({ error: error.message }, 400);
	if (error instanceof AccessError) return c.json({ error: error.message }, 403);
	if (error instanceof FileError) return c.json({ error: error.message }, 400);
	if (error instanceof GitHubError || error instanceof MailError || error instanceof SsoError || error instanceof SkillError || error instanceof ModelError || error instanceof JourneyError) return c.json({ error: error.message }, 400);
	if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
	console.error(error);
	return c.json({ error: errorMessage(error) }, 500);
});

app.get("/healthz", (c) => c.text("ok"));

/** Starts an app at most once at a time: visitors and the waiting page's polling share one start. */
const starting = new Map<string, Promise<unknown>>();
function startOnce(key: string, name: string, start: () => Promise<unknown>): void {
	if (starting.has(key)) return;
	const run = start()
		.catch((error) => console.error(`[wake] ${name}: could not start: ${errorMessage(error)}`))
		.finally(() => starting.delete(key));
	starting.set(key, run);
}

/** The waiting page with Axel, which reloads into the app once it answers. */
function waitingPage(c: Context<AppEnv>, name: string, why: string): Response {
	c.header(STARTING_HEADER, "1");
	c.header("Cache-Control", "no-store");
	return c.html(startingPage(name, why), 503);
}

// While an app starts, people see a waiting page instead of a gateway error. Two ways lead here:
// a sleeping preview, or a published app taken down for lack of visits, has no route of its own, so
// Traefik's fallback router (platform-wake in docker-compose.yml) sends the request here; and an app
// whose container runs but doesn't answer yet (502-504) is sent here by the agency-starting
// middleware on its route. This starts the app if needed and serves the page, which polls until the
// app answers.
app.use("*", async (c, next) => {
	const host = (c.req.header("Host") ?? "").split(":")[0].toLowerCase();
	const slug = slugFromHost(host, config.baseDomain);
	if (!slug) return next();
	const project = await getProjectBySlug(slug);
	const user = await currentUser(c);
	if (!user) return c.redirect(`${config.publicUrl}/?next=${encodeURIComponent(`${config.scheme}://${host}${c.req.path}`)}`, 302);
	if (!project || !(await projectRole(user, project))) return c.text("App not found", 404);
	if (host === previewHost(slug)) {
		startOnce(`preview:${project.id}`, project.name, () => wake(project));
		return waitingPage(c, project.name, "Axel is getting the preview ready. This can take up to a minute.");
	}
	const active = (await listDeployments(project)).find((d) => d.active);
	if (!active) return c.text("This app isn't published", 404);
	if (!(await appRuntime.running(project))) startOnce(`app:${project.id}`, project.name, () => wakeApp(project));
	const why = project.app_asleep_since ? "Nobody had opened it for a while, so it was taken offline. " : "";
	return waitingPage(c, project.name, `${why}This can take a minute or two.`);
});
app.get("/auth/verify", (c) => verifyForwardAuth(c));
app.route("/gateway", gateway);
app.route("/mcp", mcpApp);
app.route("/internal", bedrockApp);

// Providers send the admin back here after they approve a connection's access.
app.get("/oauth/callback", async (c) => {
	const back = (params: Record<string, string>) => c.redirect(`/#/settings/connections?${new URLSearchParams(params)}`, 302);
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return back({ oauth_error: "Sign in as an admin, then click Connect again." });
	const error = c.req.query("error_description") ?? c.req.query("error");
	if (error) return back({ oauth_error: error });
	try {
		const name = await finishSignIn(c.req.query("state") ?? "", c.req.query("code") ?? "", user.id);
		return back({ connected: name });
	} catch (err) {
		return back({ oauth_error: errorMessage(err) });
	}
});

// One-click GitHub: create the app from a manifest on GitHub, then install it on the organization.
const settingsBack = (c: Context<AppEnv>, params: Record<string, string>) => c.redirect(`/#/settings/github?${new URLSearchParams(params)}`, 302);

app.get("/github/app/start", async (c) => {
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return settingsBack(c, { github_error: "Only admins can connect GitHub" });
	try {
		return c.html(appManifestPage({ owner: c.req.query("owner"), webUrl: c.req.query("webUrl") }));
	} catch (error) {
		return settingsBack(c, { github_error: errorMessage(error) });
	}
});

app.get("/github/app/created", async (c) => {
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return settingsBack(c, { github_error: "Sign in as an admin, then click Connect GitHub again." });
	try {
		return c.redirect(await finishAppManifest(c.req.query("state") ?? "", c.req.query("code") ?? ""), 302);
	} catch (error) {
		return settingsBack(c, { github_error: errorMessage(error) });
	}
});

app.get("/github/app/installed", async (c) => {
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return settingsBack(c, { github_error: "Sign in as an admin to finish connecting GitHub." });
	// An organization member who isn't an owner can only request the install; an owner approves it on GitHub.
	if (c.req.query("setup_action") === "request") return settingsBack(c, { github_error: "GitHub sent the install to an organization owner to approve. Come back here once they do." });
	try {
		await finishAppInstall(Number(c.req.query("installation_id")));
		return settingsBack(c, { github: "connected" });
	} catch (error) {
		return settingsBack(c, { github_error: errorMessage(error) });
	}
});

// ---------------------------------------------------------------------------
// Session

app.get("/api/sign-in-options", async (c) => c.json(await signInOptions()));

// Single sign-on: the identity provider sends people back to /auth/sso/callback.
app.get("/auth/sso/start", async (c) => {
	try {
		return c.redirect(await ssoStartUrl(safeNext(c.req.query("next"))), 302);
	} catch (error) {
		return c.redirect(`/?sso_error=${encodeURIComponent(errorMessage(error))}`, 302);
	}
});

app.get("/auth/sso/callback", async (c) => {
	const fail = (message: string) => c.redirect(`/?sso_error=${encodeURIComponent(message)}`, 302);
	const error = c.req.query("error_description") ?? c.req.query("error");
	if (error) return fail(error);
	try {
		const { email, name, next } = await ssoFinish(c.req.query("state") ?? "", c.req.query("code") ?? "");
		await loginWithSso(c, email, name);
		return c.redirect(next, 302);
	} catch (err) {
		return fail(errorMessage(err));
	}
});

app.post("/api/login", async (c) => {
	const body = await c.req.json<{ email: string; password: string; next?: string }>();
	let user: User | undefined;
	try {
		user = await login(c, body.email ?? "", body.password ?? "");
	} catch (error) {
		if (error instanceof LoginError) return c.json({ error: error.message }, 403);
		throw error;
	}
	if (!user) return c.json({ error: "Wrong email or password" }, 401);
	return c.json({ user, next: safeNext(body.next) });
});

app.post("/api/logout", async (c) => {
	await logout(c);
	return c.json({ ok: true });
});

const api = new Hono<AppEnv>();
api.use("*", requireUser);

api.get("/me", async (c) =>
	c.json({ user: c.get("user"), baseDomain: config.baseDomain, usage: await usageFor(c.get("user").id) }),
);

api.get("/usage", async (c) => c.json(await usageDetail(c.get("user").id)));

/** The models members may pick in the chat, and the organization default. */
api.get("/models", async (c) => c.json(await allowedModels()));

// ---------------------------------------------------------------------------
// Projects

type ProjectContext = { get(key: "user"): User; req: { param(name: "id"): string } };

/** Loads the route's project and checks the signed-in member has at least the given role on it. */
async function projectFor(c: ProjectContext, needed: ProjectRole): Promise<{ project: Project; role: ProjectRole }> {
	const project = await getProject(c.req.param("id"));
	if (!project) throw new NotFoundError("App not found");
	const role = await assertRole(c.get("user"), project, needed);
	touch(project.id);
	return { project, role };
}

/** Like projectFor, for routes that work inside the sandbox: starts it if the app was asleep. */
async function sandboxFor(c: ProjectContext, needed: ProjectRole): Promise<{ project: Project; role: ProjectRole }> {
	const found = await projectFor(c, needed);
	await wake(found.project);
	return found;
}

api.get("/projects", async (c) => {
	const user = c.get("user");
	const projects = await visibleProjects(user);
	return c.json(await Promise.all(projects.map(async (p) => projectView(p, await projectRole(user, p)))));
});

api.post("/projects", async (c) => {
	const body = await c.req.json<{ name?: string; prompt?: string }>();
	const given = (body.name ?? "").trim().slice(0, 60);
	const prompt = body.prompt?.trim() ?? "";
	if (!given && !prompt) return c.json({ error: "Describe the app or give it a name" }, 400);
	const user = c.get("user");
	if (prompt) await assertBudget(user.id);
	// Name and subdomain come from the request, unless the creator typed a name.
	const named = await nameApp(prompt, given);
	const project = await createProject(named.name, user.id, named.slug);
	if (named.usage) await recordUsage(user.id, project.id, named.usage).catch(() => {});
	linkNewApp(project.id);
	if (prompt) {
		bridgeFor(project)
			.prompt(prompt, user.id)
			.catch((error) => console.error(`[agent ${project.slug}] first prompt failed: ${errorMessage(error)}`));
	}
	return c.json(await projectView(project, "owner"), 201);
});

api.get("/projects/:id", async (c) => {
	const { project, role } = await projectFor(c, "viewer");
	return c.json(await projectView(project, role));
});

api.patch("/projects/:id", async (c) => {
	const { project, role } = await projectFor(c, "editor");
	const body = await c.req.json<{ name?: string }>();
	const name = (body.name ?? "").replace(/\s+/g, " ").trim();
	if (!name) return c.json({ error: "Name is required" }, 400);
	if (name.length > 60) return c.json({ error: "Keep the name under 60 characters" }, 400);
	await renameProject(project, name);
	return c.json(await projectView(project, role));
});

// ---------------------------------------------------------------------------
// Sharing: who besides the owner and admins can view or change an app

api.get("/projects/:id/sharing", async (c) => {
	const { project, role } = await projectFor(c, "viewer");
	return c.json({ ...(await getSharing(project)), canManage: role === "owner" });
});

api.put("/projects/:id/sharing", async (c) => {
	const { project } = await projectFor(c, "owner");
	const body = await c.req.json<{ teamAccess?: string; member?: { userId: string; role: string | null } }>();
	if (body.teamAccess !== undefined) await setTeamAccess(project, body.teamAccess);
	if (body.member) await setMember(project, String(body.member.userId ?? ""), body.member.role ?? null);
	const updated = (await getProject(project.id))!;
	return c.json({ ...(await getSharing(updated)), canManage: true });
});

/** Everyone on the team, for picking people to share an app with. */
api.get("/people", async (c) =>
	c.json(await query<{ id: string; email: string; name: string }>("select id, email, name from users order by email")),
);

api.delete("/projects/:id", async (c) => {
	const { project } = await projectFor(c, "owner");
	dropBridge(project.id);
	closeDataPools(project);
	await deleteProject(project);
	return c.json({ ok: true });
});

api.get("/projects/:id/messages", async (c) => {
	const { project } = await projectFor(c, "viewer");
	// Opening the builder moves an idle app onto the current sandbox image (its files and data stay).
	if (!bridgeFor(project).running && (await sandboxOutdated(project))) {
		dropBridge(project.id);
		await ensureSandbox(project, { upgrade: true });
	}
	return c.json({ messages: await bridgeFor(project).messages(), running: bridgeFor(project).running });
});

/**
 * JSON `{ message, mode?, model?, selection? }`, or multipart with those fields and `files` (chat attachments).
 * `mode` is auto (build), plan or chat; `model` is a catalog key, used if an admin allowed it; `selection`
 * is the part of the preview the person pointed at (selection.ts).
 */
api.post("/projects/:id/prompt", async (c) => {
	const { project } = await sandboxFor(c, "editor");
	let fields: Record<string, unknown>;
	const files: Attachment[] = [];
	if ((c.req.header("Content-Type") ?? "").startsWith("multipart/form-data")) {
		fields = await c.req.parseBody({ all: true });
		for (const entry of [fields.files ?? []].flat()) {
			if (entry instanceof File) files.push({ name: entry.name, type: entry.type, data: Buffer.from(await entry.arrayBuffer()) });
		}
	} else {
		fields = await c.req.json<Record<string, unknown>>();
	}
	const message = String(fields.message ?? "").trim();
	const mode = CHAT_MODES.find((m) => m === fields.mode) ?? ("auto" as ChatMode);
	const model = typeof fields.model === "string" ? fields.model : undefined;
	if (!message && files.length === 0) return c.json({ error: "Message is empty" }, 400);
	checkAttachments(files);
	await assertBudget(c.get("user").id);
	const paths = await saveAttachments(project, files);
	const text = promptWithAttachments(promptWithSelection(message, selectionContext(fields.selection)), paths);
	const result = await bridgeFor(project).prompt(text, c.get("user").id, modelImages(files), { mode, model });
	return c.json({ ...(result as object), attachments: paths });
});

api.post("/projects/:id/abort", async (c) => {
	const { project } = await projectFor(c, "editor");
	await bridgeFor(project).abort();
	return c.json({ ok: true });
});

api.get("/projects/:id/events", async (c) => {
	const { project } = await projectFor(c, "viewer");
	const bridge = bridgeFor(project);
	return streamSSE(c, async (stream) => {
		const queue: AgentEvent[] = [];
		let wake: (() => void) | undefined;
		const unsubscribe = bridge.subscribe((event) => {
			queue.push(event);
			wake?.();
		});
		const unwatch = watch(project.id);
		stream.onAbort(() => {
			unsubscribe();
			unwatch();
		});
		await stream.writeSSE({ event: "hello", data: JSON.stringify({ running: bridge.running }) });
		while (!stream.aborted) {
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
					setTimeout(resolve, 20_000);
				});
				wake = undefined;
				if (queue.length === 0) {
					await stream.writeSSE({ event: "ping", data: "{}" });
					continue;
				}
			}
			const event = queue.shift()!;
			await stream.writeSSE({ data: JSON.stringify(event) });
		}
		unsubscribe();
		unwatch();
	});
});

api.post("/projects/:id/restart", async (c) => {
	const { project } = await projectFor(c, "editor");
	dropBridge(project.id);
	await ensureSandbox(project);
	await execIn(project, "pkill -f 'next dev' || true");
	return c.json({ ok: true });
});

api.get("/projects/:id/logs", async (c) => {
	const { project } = await sandboxFor(c, "viewer");
	const result = await execIn(project, "tail -n 200 /tmp/dev.log 2>/dev/null || true");
	return c.text(result.stdout);
});

api.get("/projects/:id/versions", async (c) => {
	const { project } = await sandboxFor(c, "viewer");
	const result = await execIn(project, "git log -n 50 --format='%h%x09%cI%x09%s'");
	const versions = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [commit, date, ...subject] = line.split("\t");
			return { commit, date, subject: subject.join("\t") };
		});
	return c.json(versions);
});

api.post("/projects/:id/restore", async (c) => {
	const { project } = await sandboxFor(c, "editor");
	const { commit } = await c.req.json<{ commit: string }>();
	if (!/^[0-9a-f]{4,40}$/.test(commit ?? "")) return c.json({ error: "Invalid version" }, 400);
	if (bridgeFor(project).running) return c.json({ error: "Wait for the agent to finish first" }, 409);
	// Restores the tree of an earlier commit as a new commit, so history is kept.
	const script = `set -e
git checkout ${commit} -- .
git diff --name-only --diff-filter=A ${commit} HEAD | xargs -r git rm -q --
git add -A
git diff --cached --quiet || git commit -q -m "Restore ${commit}"
git rev-parse --short HEAD`;
	const result = await execIn(project, script);
	if (result.code !== 0) return c.json({ error: result.stderr || result.stdout }, 400);
	autoPush(project.id);
	return c.json({ commit: result.stdout.trim() });
});

// ---------------------------------------------------------------------------
// Code view: the app's source files inside its sandbox

api.get("/projects/:id/files", async (c) => {
	const { project } = await sandboxFor(c, "viewer");
	return c.json({ files: await listFiles(project) });
});

api.get("/projects/:id/file", async (c) => {
	const { project } = await sandboxFor(c, "viewer");
	try {
		return c.json(await readFile(project, c.req.query("path") ?? ""));
	} catch (error) {
		if (error instanceof FileError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

api.put("/projects/:id/file", async (c) => {
	const { project } = await sandboxFor(c, "editor");
	const body = await c.req.json<{ path: string; content: string }>();
	if (typeof body.content !== "string") return c.json({ error: "Content is required" }, 400);
	// The agent commits its whole tree when it settles; a save in the middle of a run would get mixed into it.
	if (bridgeFor(project).running) return c.json({ error: "The agent is working. Save again when it finishes." }, 409);
	try {
		const saved = await writeFile(project, body.path, body.content);
		autoPush(project.id);
		return c.json(saved);
	} catch (error) {
		if (error instanceof FileError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

// ---------------------------------------------------------------------------
// Data view: the app's own database, preview or live. Anyone can edit the preview's data;
// changing live data takes the app's owner or an admin, others can only read it.

function dataEnv(value: string | undefined): DataEnv {
	return value === "live" ? "live" : "preview";
}

async function dataAccess(c: ProjectContext & { req: { query(name: string): string | undefined } }) {
	const { project, role } = await projectFor(c, "viewer");
	const env = dataEnv(c.req.query("env"));
	// Editors change preview data; live data takes the owner or an admin. Everyone else reads.
	const canWrite = env === "preview" ? atLeast(role, "editor") : role === "owner";
	return { project, env, canWrite };
}

api.get("/projects/:id/data/tables", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (env === "live" && !project.live_db_name) return c.json({ tables: [], canWrite, missing: true });
	return c.json({ tables: await listTables(project, env), canWrite, missing: false });
});

api.get("/projects/:id/data/rows", async (c) => {
	const { project, env } = await dataAccess(c);
	const table = c.req.query("table") ?? "";
	return c.json(await readRows(project, env, table, Number(c.req.query("offset")), Number(c.req.query("limit"))));
});

api.post("/projects/:id/data/rows", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (!canWrite) return c.json({ error: env === "live" ? "Only the app's owner or an admin can change live data" : "You can view this app's data but not change it" }, 403);
	const body = await c.req.json<{ table: string; values: Record<string, string | null> }>();
	await insertRow(project, env, body.table, body.values ?? {});
	return c.json({ ok: true });
});

api.patch("/projects/:id/data/rows", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (!canWrite) return c.json({ error: env === "live" ? "Only the app's owner or an admin can change live data" : "You can view this app's data but not change it" }, 403);
	const body = await c.req.json<{ table: string; key: Record<string, unknown>; values: Record<string, string | null> }>();
	await updateRow(project, env, body.table, body.key ?? {}, body.values ?? {});
	return c.json({ ok: true });
});

api.delete("/projects/:id/data/rows", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (!canWrite) return c.json({ error: env === "live" ? "Only the app's owner or an admin can change live data" : "You can view this app's data but not change it" }, 403);
	const body = await c.req.json<{ table: string; key: Record<string, unknown> }>();
	await deleteRow(project, env, body.table, body.key ?? {});
	return c.json({ ok: true });
});

api.post("/projects/:id/data/sql", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	const body = await c.req.json<{ sql: string }>();
	return c.json(await runSql(project, env, String(body.sql ?? ""), !canWrite));
});

api.get("/projects/:id/deployments", async (c) => {
	const { project } = await projectFor(c, "viewer");
	return c.json(await listDeployments(project));
});

api.post("/projects/:id/publish", async (c) => {
	const { project } = await sandboxFor(c, "editor");
	const user = c.get("user");
	return streamSSE(c, async (stream) => {
		try {
			const deployment = await publish(project, user.id, (line) => {
				void stream.writeSSE({ event: "log", data: JSON.stringify(line) });
			});
			await stream.writeSSE({ event: "done", data: JSON.stringify(deployment) });
		} catch (error) {
			await stream.writeSSE({ event: "failed", data: JSON.stringify(errorMessage(error)) });
		}
	});
});

// ---------------------------------------------------------------------------
// The journey: the stages an app goes through, and approval before publishing (journey.ts)

api.get("/projects/:id/journey", async (c) => {
	const { project, role } = await sandboxFor(c, "viewer");
	return c.json({ ...(await journeyView(project)), canApprove: await canApprove(c.get("user"), role === "owner") });
});

api.put("/projects/:id/journey/:stage", async (c) => {
	const { project, role } = await sandboxFor(c, "editor");
	const body = await c.req.json<{ done?: boolean }>();
	await setStage(project, c.get("user"), c.req.param("stage"), body.done !== false, role === "owner");
	return c.json({ ...(await journeyView(project)), canApprove: await canApprove(c.get("user"), role === "owner") });
});

api.post("/projects/:id/journey/request-approval", async (c) => {
	const { project } = await sandboxFor(c, "editor");
	const body = await c.req.json<{ note?: string }>().catch(() => ({ note: "" }));
	const note = String(body.note ?? "").trim().slice(0, 500);
	return c.json({ asked: await requestApproval(project, c.get("user"), note) });
});

api.post("/projects/:id/rollback", async (c) => {
	const { project } = await projectFor(c, "editor");
	const { version } = await c.req.json<{ version: number }>();
	return c.json(await rollback(project, Number(version)));
});

// Starts a published app that was taken down for lack of visits, without waiting for a visitor.
api.post("/projects/:id/wake-app", async (c) => {
	const { project } = await projectFor(c, "editor");
	if (!project.app_asleep_since) return c.json({ ok: true });
	await wakeApp(project);
	return c.json({ ok: true });
});

api.post("/projects/:id/unpublish", async (c) => {
	const { project } = await projectFor(c, "editor");
	await unpublish(project);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GitHub: push an app's code to the organization's GitHub

api.get("/projects/:id/github", async (c) => {
	const { project, role } = await projectFor(c, "viewer");
	return c.json({ ...projectGitHub(project, await getGitHub()), canLink: role === "owner", canPush: atLeast(role, "editor") });
});

api.post("/projects/:id/github/link", async (c) => {
	const { project } = await projectFor(c, "owner");
	const body = await c.req.json<{ create?: boolean; repo?: string; branch?: string; private?: boolean; autoPush?: boolean }>();
	await linkRepository(project, body);
	const linked = (await getProject(project.id))!;
	// A new link pushes right away, so the repository shows the app's code.
	const push = await pushToGitHub(linked).then(
		() => null,
		(error) => errorMessage(error),
	);
	return c.json({ ...projectGitHub((await getProject(project.id))!, await getGitHub()), pushError: push });
});

api.patch("/projects/:id/github", async (c) => {
	const { project } = await projectFor(c, "owner");
	const body = await c.req.json<{ autoPush?: boolean }>();
	await setAutoPush(project, Boolean(body.autoPush));
	return c.json(projectGitHub((await getProject(project.id))!, await getGitHub()));
});

api.delete("/projects/:id/github", async (c) => {
	const { project } = await projectFor(c, "owner");
	await unlinkRepository(project);
	return c.json(projectGitHub((await getProject(project.id))!, await getGitHub()));
});

api.post("/projects/:id/github/push", async (c) => {
	const { project } = await sandboxFor(c, "editor");
	if (bridgeFor(project).running) return c.json({ error: "Wait for the agent to finish, then push" }, 409);
	const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
	return c.json(await pushToGitHub(project, { force: Boolean(body.force) }));
});

// ---------------------------------------------------------------------------
// Settings: single sign-on and GitHub (admins)

api.get("/settings", requireAdmin, async (c) =>
	c.json({ sso: await ssoView(), github: await gitHubView(), githubNewApps: await newAppsDefaults(), publicUrl: config.publicUrl }),
);

api.get("/settings/email", requireAdmin, async (c) => c.json({ ...(await mailView()), appIdleDays: config.appIdleDays }));

api.put("/settings/email", requireAdmin, async (c) => c.json(await saveSmtp(await c.req.json())));

api.delete("/settings/email", requireAdmin, async (c) => c.json(await removeSmtp()));

// Sends a test email to the admin who asks, through whatever is set up.
api.post("/settings/email/test", requireAdmin, async (c) => {
	const user = c.get("user");
	if (!(await canSendMail())) return c.json({ error: "Set up an SMTP server first" }, 400);
	await sendMail({
		to: user.email,
		subject: "Test email from Agency",
		text: `This is a test from ${config.publicUrl}. Email works: Agency can tell owners when their apps are taken offline.\n\nAgency`,
	});
	return c.json({ ok: true, to: user.email });
});

api.get("/settings/journey", requireAdmin, async (c) => c.json(await journeySettings()));

api.put("/settings/journey", requireAdmin, async (c) => c.json(await saveJourneySettings(await c.req.json())));

api.get("/settings/models", requireAdmin, async (c) => c.json(await modelSettings()));

api.put("/settings/models", requireAdmin, async (c) => c.json(await saveModelSettings(await c.req.json())));

api.put("/settings/github/new-apps", requireAdmin, async (c) => c.json(await saveNewAppsDefaults(await c.req.json())));

api.put("/settings/sso", requireAdmin, async (c) => c.json(await saveSso(await c.req.json())));

api.put("/settings/github", requireAdmin, async (c) => c.json(await saveGitHub(await c.req.json())));

api.delete("/settings/github", requireAdmin, async (c) => {
	await removeGitHub();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Skills: each member's own (/skills), and the organization's (/org-skills), which admins manage and
// every build loads. A member's builds use both.

function skillRoutes(prefix: string, scopeOf: (c: Context<AppEnv>) => Owner, guard: MiddlewareHandler<AppEnv>) {
	api.get(prefix, async (c) => c.json({ skills: await listSkills(scopeOf(c)), template: SKILL_TEMPLATE }));

	api.get(`${prefix}/:id`, async (c) => c.json(await getSkill(scopeOf(c), c.req.param("id"))));

	api.post(prefix, guard, async (c) => {
		const body = await c.req.json<{ content?: string }>();
		return c.json(await createSkill(scopeOf(c), String(body.content ?? "")), 201);
	});

	/** The raw file is the body; its name comes in the query string. */
	api.post(`${prefix}/upload`, guard, async (c) => {
		const data = Buffer.from(await c.req.arrayBuffer());
		if (data.length === 0) return c.json({ error: "The file is empty" }, 400);
		return c.json(await importUpload(scopeOf(c), c.req.query("filename") ?? "", data));
	});

	api.post(`${prefix}/github`, guard, async (c) => {
		const body = await c.req.json<{ url?: string }>();
		return c.json(await importFromGitHub(scopeOf(c), String(body.url ?? "")));
	});

	api.post(`${prefix}/:id/refresh`, guard, async (c) => c.json(await refreshSkill(scopeOf(c), c.req.param("id"))));

	api.put(`${prefix}/:id`, guard, async (c) => {
		const body = await c.req.json<{ content?: string; enabled?: boolean }>();
		return c.json(await updateSkill(scopeOf(c), c.req.param("id"), body));
	});

	api.delete(`${prefix}/:id`, guard, async (c) => {
		await deleteSkill(scopeOf(c), c.req.param("id"));
		return c.json({ ok: true });
	});
}

skillRoutes("/skills", (c) => c.get("user").id, async (_c, next) => next());
skillRoutes("/org-skills", () => null, requireAdmin);

// ---------------------------------------------------------------------------
// Connections

api.get("/connections", async (c) => c.json(await listConnections()));

api.post("/connections", requireAdmin, async (c) => {
	const body = await c.req.json<{
		name: string;
		kind: ConnectionKind;
		description?: string;
		allowWrite?: boolean;
		config: ConnectionConfig;
	}>();
	if (!CONNECTION_KINDS.includes(body.kind)) return c.json({ error: "Unknown kind" }, 400);
	try {
		const connection = await createConnection({
			name: body.name,
			kind: body.kind,
			description: body.description ?? "",
			allowWrite: Boolean(body.allowWrite),
			config: body.config,
		});
		return c.json(connection, 201);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.post("/connections/:name/test", async (c) => {
	try {
		return c.json({ ok: true, message: await testConnection(c.req.param("name")) });
	} catch (error) {
		return c.json({ ok: false, message: errorMessage(error) });
	}
});

api.put("/connections/:id/projects", requireAdmin, async (c) => {
	const body = await c.req.json<{ allProjects?: boolean; projectIds?: string[] }>();
	const ids = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
	return c.json(await setConnectionProjects(c.req.param("id"), body.allProjects !== false, ids));
});

api.post("/connections/:id/connect", requireAdmin, async (c) => {
	try {
		const url = await startSignIn(c.req.param("id"), c.get("user").id);
		return c.json({ url });
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.post("/connections/:id/disconnect", requireAdmin, async (c) => {
	await signOut(c.req.param("id"));
	return c.json({ ok: true });
});

api.delete("/connections/:id", requireAdmin, async (c) => {
	await deleteConnection(c.req.param("id"));
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team

api.get("/users", requireAdmin, async (c) => c.json(await listUsersWithUsage()));

api.post("/users", requireAdmin, async (c) => {
	const body = await c.req.json<{
		email: string;
		name?: string;
		password: string;
		role?: User["role"];
		budgetUsd?: number | string;
		unlimited?: boolean;
	}>();
	if (!body.email || !body.password || body.password.length < 10) {
		return c.json({ error: "Email and a password of at least 10 characters are required" }, 400);
	}
	try {
		const budget = { budgetUsd: parseBudget(body.budgetUsd), unlimited: Boolean(body.unlimited) };
		const role = body.role === "admin" ? "admin" : "member";
		return c.json(await createUser(body.email, body.name ?? "", body.password, role, budget), 201);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.patch("/users/:id/budget", requireAdmin, async (c) => {
	const body = await c.req.json<{ budgetUsd?: number | string; unlimited?: boolean }>();
	try {
		const unlimited = typeof body.unlimited === "boolean" ? body.unlimited : undefined;
		await setBudget(c.req.param("id"), parseBudget(body.budgetUsd), unlimited);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
	return c.json(await usageFor(c.req.param("id")));
});

api.patch("/users/:id/role", requireAdmin, async (c) => {
	const body = await c.req.json<{ role?: string }>();
	if (body.role !== "admin" && body.role !== "member") return c.json({ error: "Role must be admin or member" }, 400);
	if (c.req.param("id") === c.get("user").id) return c.json({ error: "Another admin has to change your role" }, 400);
	try {
		return c.json(await setRole(c.req.param("id"), body.role));
	} catch (error) {
		if (error instanceof RoleError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

api.delete("/users/:id", requireAdmin, async (c) => {
	if (c.req.param("id") === c.get("user").id) return c.json({ error: "You cannot remove yourself" }, 400);
	await query("delete from users where id = $1", [c.req.param("id")]);
	return c.json({ ok: true });
});

app.route("/api", api);

// ---------------------------------------------------------------------------
// Web UI: static files plus Preact and htm served from node_modules (no build step).

app.get("/vendor/preact/*", serveStatic({ root: config.nodeModules, rewriteRequestPath: (p) => p.replace("/vendor/preact", "preact/dist") }));
app.get(
	"/vendor/hooks/*",
	serveStatic({ root: config.nodeModules, rewriteRequestPath: (p) => p.replace("/vendor/hooks", "preact/hooks/dist") }),
);
app.get("/vendor/htm/*", serveStatic({ root: config.nodeModules, rewriteRequestPath: (p) => p.replace("/vendor/htm", "htm/dist") }));
// ES modules for the code editor (CodeMirror), resolved to each package's entry file. Only these packages are served.
const ESM_PACKAGES = /^(codemirror|style-mod|w3c-keyname|crelt|@codemirror\/[a-z-]+|@lezer\/[a-z-]+|@marijn\/find-cluster-break)$/;
const esmEntries = new Map<string, string>();
app.use("/vendor/*", compress());
app.get("/vendor/esm/*", (c) => {
	const name = c.req.path.slice("/vendor/esm/".length);
	if (!ESM_PACKAGES.test(name)) return c.notFound();
	let file = esmEntries.get(name);
	if (!file) {
		const dir = `${config.nodeModules}${name}/`;
		if (!existsSync(`${dir}package.json`)) return c.notFound();
		const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf8"));
		const entry = pkg.exports?.["."]?.import ?? pkg.exports?.import ?? pkg.module ?? pkg.main ?? "index.js";
		file = `${dir}${typeof entry === "string" ? entry : entry.default}`;
		esmEntries.set(name, file);
	}
	c.header("Content-Type", "text/javascript; charset=utf-8");
	c.header("Cache-Control", "public, max-age=86400");
	return c.body(readFileSync(file, "utf8"));
});
app.get("/static/*", serveStatic({ root: config.webRoot, rewriteRequestPath: (p) => p.replace("/static", "") }));
const indexHtml = readFileSync(`${config.webRoot}index.html`, "utf8");
app.get("*", (c) => c.html(indexHtml));

await migrate();
await ensureAdmin();
startIdleSweeper();
startAppIdleSweeper();
appRuntime.start();
sandboxes.start();
serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`agency platform listening on :${info.port} for ${config.publicUrl}`);
});
