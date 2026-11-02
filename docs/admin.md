# Running Agency for a team

[Back to the README](../README.md)

What admins set up, and how members share the apps they build.

## Settings

Everything that isn't an app lives under **Settings**, grouped like most workspace tools: **Account** (My skills, Usage) and **Organization** (Connections, Skills, and for admins Team, Models, Single sign-on, GitHub). On a phone, Settings opens as a list of sections. Old links such as `#/connections` still work.

## Models and chat modes

Under **Settings > Organization > Models** an admin sees every Claude model the deploy's provider offers (Claude API or Bedrock), ticks the ones members may use and picks the organization default. Until then only the model the deploy was set up with is allowed. In the builder chat, members pick one of the allowed models and a mode: **Auto** builds right away (the default), **Plan** proposes a plan and waits for "Build this plan", **Chat** answers and discusses without changing files. Plan and Chat give the agent read-only tools (plus the organization data tools). Each message is charged to the member's budget at the price of the model that answered.

## Sharing apps

Every app has an owner (whoever created it); admins can do everything with every app. In the builder's **Share** sheet the owner picks what the rest of the team gets (nothing, view, or edit) and adds people as viewers or editors:

- **Viewer**: opens the preview and the published app, and reads the builder (chat, code, data) without changing anything.
- **Editor**: also chats with the agent, edits code and preview data, restores versions and publishes.
- **Owner and admins**: also change live data, sharing and delete the app.

New apps start as view-only for the team; apps created before sharing existed stay editable by everyone. Traefik's sign-in check enforces the same rules on `<app>.<domain>` and `<app>-preview.<domain>`, and passes the role to apps as `X-Agency-App-Role` (`currentUser().appRole`).

## Ideas

**Ideas** in the sidebar is where the organization collects what it would like built. Anyone writes an idea in their own words; the agent (the same small, fast model that names apps) organizes it into a title, the problem, who has it and what it would save, and points out similar open ideas and existing apps that may already cover it. The cost of organizing an idea is charged to its author like any other AI use. People vote for ideas and press **I'd build this** to offer to build one.

Admins run the pipeline rather than build in it: they set an idea's status (open, planned, being built, done, not now) with a note everyone sees, merge duplicates (votes, offers and text move to the idea that stays), and press **Start an app** for the builder they pick, often someone who offered. That builder gets a new app whose agent starts by writing `SPEC.md` from the idea and asking about what it doesn't say, and an email. Authors can withdraw their own ideas.

Published apps also show a small **Suggest an improvement** button in the corner (in Hebrew when the browser is). It opens Ideas with the app filled in, the suggestion is organized the same way, and the app's owner gets an email; the owner or an admin presses **Plan it in the app's chat** to hand it to the agent in Plan mode, so nothing changes before they approve a plan. The button comes with new apps; an existing app gets it when `instrumentation-client.ts` in its code is replaced with the template's.

<img src="assets/screenshots/ideas.png" alt="Ideas: organized ideas with votes, offers to build, an admin's note and an improvement to an existing app" width="100%">
<img src="assets/screenshots/suggest.png" alt="A published app with the Suggest an improvement button in the corner, in Hebrew" width="100%">

## Roles

Everyone is an **admin** or a **member**. Admins manage the team, connections and organization settings, and can open and change every app; members build their own apps and the ones shared with them. An admin changes someone's role from the menu next to their name under **Settings > Team**, and the change applies on that person's next click. You can't change your own role (another admin has to), and the organization always keeps at least one admin. With single sign-on, password sign-in may be open to admins only, so a member who used a password needs to sign in through SSO.

## Usage and budgets

The cost of every message the agent writes (tokens at the model's list price) is charged to the member who sent the prompt. Each member has a monthly budget in US dollars, or is unlimited; when it is used up, new prompts are refused until an admin raises it or the month resets on the 1st (a step already running still finishes). Everyone sees their spend under **Settings > Usage** and in the sidebar; admins set budgets under **Settings > Team**. New members get `AGENCY_DEFAULT_BUDGET_USD` (20 by default).

## Single sign-on

Under **Settings**, an admin connects the organization's identity provider over OpenID Connect (Google Workspace, Microsoft Entra ID, Okta, or any other): issuer URL, client ID and secret, and the email domains that may sign in. Register `https://<your-domain>/auth/sso/callback` as the redirect URI. Only people whose verified email is in an allowed domain get in; they join as members on their first sign-in, with the default budget. Password sign-in can stay on for admins only, as a way in if the provider is down. The same session covers previews and published apps.

## Email and apps nobody opens

A published app that nobody opens for a week is taken offline to free its memory or its share of an apps server, and its owner gets an email. Its versions, data and address stay; the next visit starts it again behind a short "starting" page, and the owner can press **Start now** in the Publish panel. The app shows **Asleep** in the meantime. Change the number of days with `app_idle_days` in `infra/aws/terraform.tfvars` (or `AGENCY_APP_IDLE_DAYS`), or `0` to keep apps up.

Under **Settings > Email** an admin sets the SMTP server Agency sends from (Google Workspace, Microsoft 365, SendGrid, Mailgun, SES or your own) and sends a test email to themselves. The all-AWS setup sends through Amazon SES without any of this. Without either, no email goes out and the platform only logs it.

## GitHub

Under **Settings**, an organization owner enters the organization's name and clicks **Connect GitHub**. Agency sends them to GitHub with a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest); they confirm creating a private app in the organization (permissions: Contents and Administration write, Metadata read), then confirm installing it, and land back in Settings connected. Nothing is copied by hand. The app's private key is stored encrypted, and pushes use installation tokens that expire after an hour; which repositories the app can use is chosen in its installation settings on GitHub. **Disconnect** uninstalls it; an owner can then delete the app on GitHub. GitHub Enterprise Server works with its address. A token (fine-grained, owned by the organization, with Contents and Administration read and write) still works instead, under **Use a token instead**, and is the way to use a personal account.

Once GitHub is connected, every new app gets its own repository in the organization (private, named after the app, with -2, -3, ... when the name is taken) and pushes each version automatically. An admin can turn that off, or make new repositories public, under **Settings**.

In the builder, the **GitHub** button links an app to a new private repository or an existing one and pushes its version history; it can push every new version automatically. Credentials stay in the platform: the app's history is copied out of the sandbox as a git bundle and pushed from the platform container. A branch with commits made outside Agency is not overwritten unless someone chooses **Overwrite**.
