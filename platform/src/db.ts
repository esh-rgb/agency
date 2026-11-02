import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
	const result = await pool.query<T>(sql, params);
	return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
	const rows = await query<T>(sql, params);
	return rows[0];
}

const schema = `
create table if not exists users (
	id uuid primary key default gen_random_uuid(),
	email text not null unique,
	name text not null default '',
	password_hash text not null,
	role text not null default 'member' check (role in ('admin', 'member')),
	created_at timestamptz not null default now()
);

create table if not exists sessions (
	id text primary key,
	user_id uuid not null references users(id) on delete cascade,
	expires_at timestamptz not null
);

create table if not exists projects (
	id uuid primary key default gen_random_uuid(),
	slug text not null unique,
	name text not null,
	owner_id uuid not null references users(id),
	token text not null unique,
	db_name text not null,
	db_password_enc text not null,
	created_at timestamptz not null default now()
);

create table if not exists connections (
	id uuid primary key default gen_random_uuid(),
	name text not null unique,
	kind text not null check (kind in ('postgres', 'mcp_http', 'mcp_stdio')),
	description text not null default '',
	config_enc text not null,
	allow_write boolean not null default false,
	created_at timestamptz not null default now()
);

create table if not exists deployments (
	id serial primary key,
	project_id uuid not null references projects(id) on delete cascade,
	version integer not null,
	image text not null,
	git_commit text not null default '',
	created_by uuid references users(id),
	created_at timestamptz not null default now(),
	active boolean not null default false,
	unique (project_id, version)
);

-- Monthly spend limit per user. Admins existing before budgets were added start unlimited.
do $$
begin
	if not exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'unlimited') then
		alter table users add column unlimited boolean not null default false;
		alter table users add column monthly_budget_usd numeric(12, 2) not null default 20;
		update users set unlimited = true where role = 'admin';
	end if;
end $$;

-- One row per finished assistant message of the coding agent, attributed to the user who prompted it.
create table if not exists usage_events (
	id bigserial primary key,
	user_id uuid not null references users(id) on delete cascade,
	project_id uuid references projects(id) on delete set null,
	model text not null default '',
	input_tokens integer not null default 0,
	output_tokens integer not null default 0,
	cache_read_tokens integer not null default 0,
	cache_write_tokens integer not null default 0,
	cost_usd numeric(14, 6) not null default 0,
	created_at timestamptz not null default now()
);
create index if not exists usage_events_user_time on usage_events (user_id, created_at);

-- Published apps get their own database, separate from the preview's.
alter table projects add column if not exists live_db_name text;
alter table projects add column if not exists live_db_password_enc text;

-- Connections signed in with OAuth (MCP servers, Google Drive, Salesforce) keep their tokens here.
alter table connections drop constraint if exists connections_kind_check;
alter table connections add constraint connections_kind_check
	check (kind in ('postgres', 'mcp_http', 'mcp_stdio', 'google_drive', 'salesforce'));
alter table connections add column if not exists oauth_enc text;
alter table connections add column if not exists oauth_account text not null default '';

-- Which apps may use a connection: all of them, or only those listed in connection_projects.
alter table connections add column if not exists all_projects boolean not null default true;
create table if not exists connection_projects (
	connection_id uuid not null references connections(id) on delete cascade,
	project_id uuid not null references projects(id) on delete cascade,
	primary key (connection_id, project_id)
);

-- Who can open and change an app besides its owner and admins. team_access is what every other member gets.
-- Apps created before sharing existed stay editable by the whole team; new apps start view-only for others.
do $$
begin
	if not exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'team_access') then
		alter table projects add column team_access text not null default 'editor'
			check (team_access in ('none', 'viewer', 'editor'));
		alter table projects alter column team_access set default 'viewer';
	end if;
end $$;
-- Organization settings edited in the UI (single sign-on, GitHub). Encrypted: they hold client secrets and tokens.
create table if not exists settings (
	key text primary key,
	value_enc text not null,
	updated_at timestamptz not null default now()
);

-- The GitHub repository an app's code is pushed to.
alter table projects add column if not exists github_repo text;
alter table projects add column if not exists github_branch text not null default 'main';
alter table projects add column if not exists github_auto_push boolean not null default false;
alter table projects add column if not exists github_pushed_commit text;
alter table projects add column if not exists github_pushed_at timestamptz;

create table if not exists project_members (
	project_id uuid not null references projects(id) on delete cascade,
	user_id uuid not null references users(id) on delete cascade,
	role text not null check (role in ('viewer', 'editor')),
	primary key (project_id, user_id)
);

-- Skills for the coding agent: a member's own, or the organization's (no user_id), which load for everyone.
-- files holds the skill folder ([{path, encoding, content}]).
create table if not exists user_skills (
	id uuid primary key default gen_random_uuid(),
	user_id uuid references users(id) on delete cascade,
	name text not null,
	description text not null default '',
	source text not null default '',
	files jsonb not null default '[]',
	enabled boolean not null default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (user_id, name)
);
create unique index if not exists user_skills_org_name on user_skills (name) where user_id is null;

-- Published apps nobody opens are taken down (app-idle.ts): minutes the app has run since its last
-- visit (only while the platform runs), and when it was taken down. Its next visit starts it again.
alter table projects add column if not exists app_idle_minutes integer not null default 0;
alter table projects add column if not exists app_asleep_since timestamptz;

-- The builder's journey (journey.ts): who finished which stage of an app. The latest row per stage
-- wins; done = false reopens a stage.
create table if not exists journey_events (
	id serial primary key,
	project_id uuid not null references projects(id) on delete cascade,
	stage text not null,
	done boolean not null,
	user_id uuid references users(id) on delete set null,
	created_at timestamptz not null default now()
);
create index if not exists journey_events_project on journey_events (project_id, stage, id);

-- Requests for an admin to approve an app for an audience (journey.ts), with the justification the
-- agent wrote as it was when the request was filed.
create table if not exists approval_requests (
	id serial primary key,
	project_id uuid not null references projects(id) on delete cascade,
	requested_by uuid references users(id) on delete set null,
	audience text not null,
	justification text not null default '',
	note text not null default '',
	status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'revoked')),
	decision_note text not null default '',
	decided_by uuid references users(id) on delete set null,
	created_at timestamptz not null default now(),
	decided_at timestamptz
);
create index if not exists approval_requests_project on approval_requests (project_id, id);
create index if not exists approval_requests_pending on approval_requests (status) where status = 'pending';
`;

export async function migrate(): Promise<void> {
	await pool.query(schema);
}
