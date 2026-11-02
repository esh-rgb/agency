# Running Agency for a team

[Back to the README](../README.md)

What admins set up, and how members share the apps they build.

## Settings

Everything that isn't an app lives under **Settings**, grouped like most workspace tools: **Account** (My skills, Usage) and **Organization** (Connections, Skills, and for admins Team, Models, Single sign-on, GitHub). On a phone, Settings opens as a list of sections. Old links such as `#/connections` still work.

## Models and chat modes

Under **Settings > Organization > Models** an admin sees every Claude model the deploy's provider offers (Claude API or Bedrock), ticks the ones members may use and picks the organization default. Until then only the model the deploy was set up with is allowed. In the builder chat, members pick one of the allowed models and a mode: **Auto** builds right away (the default), **Plan** proposes a plan and waits for "Build this plan", **Chat** answers and discusses without changing files. Plan and Chat give the agent read-only tools (plus the organization data tools). Each message is charged to the member's budget at the price of the model that answered.

## The journey and approval before publishing

Every app shows a **Journey** above its chat, for people who have never built software: **Describe** (the agent asks questions and writes the spec in `SPEC.md`), **Plan** (it proposes how it will build it, in Plan mode), **Build**, **Check** (it tests the app against every point in the spec, fixes what fails and writes the results in `CHECKS.md`, with things to try by hand), **Approve** and **Publish**. Each stage explains what happens, has a button that asks the agent for its part in the right mode, and is marked done by an editor; the spec and the checks open from the journey. The steps are a guide: people can still just chat.

Under **Settings > Organization > Publishing** an admin can require approval before an app is shared with the whole organization. The admin runs the platform rather than building on it, and decides what goes live; the approval is built so it doesn't become a bottleneck:

- **Risk follows who the app is for.** An app shared only with named people (a team) goes live without asking. One the whole organization can open needs an admin's approval. Beyond that, each organization names its own outside audiences on the same page, as its policy defines them (customers, beneficiaries, vendors, partners, suppliers...), and whether an app for each needs approval. A builder picks one when asking; approval for an outside audience also covers the whole organization. Agency doesn't share apps outside the organization yet, so for now these approvals record the decision for when it does.
- **Once per level.** After an app is approved, its updates are published without asking again. Sharing it more widely than what was approved needs a new approval.
- **A justification with every request.** In the journey's Approve stage the agent writes `JUSTIFICATION.md`: the problem, who uses the app and how often, what it saves, which data it touches, who can open it, the risks and the running cost. The builder reads it, picks the audience, adds a note and presses **Ask for approval**; the request keeps a copy of the justification as it was sent.
- **One queue.** Admins see the requests under **Approvals** in the sidebar, with a count. Each one has the justification and a link to the app (preview, spec and checks); the admin approves it or sends it back with a note, and can revoke an approval later. What is live stays live after a revoke, but the app can't be published again until it's approved. Admins get an email for each request, and builders for each decision.

With the setting off, the owner marks the app ready to publish, and publishing doesn't wait for it.

<img src="assets/screenshots/journey.png" alt="The journey's Approve stage: prepare the justification, pick who the app is for, and ask for approval" width="100%">
<img src="assets/screenshots/approvals.png" alt="Approvals: a request with the agent's justification, Approve and Send back, and earlier decisions" width="100%">
<img src="assets/screenshots/publishing.png" alt="Settings, Publishing: Require an admin's approval before an app is shared with the whole organization" width="100%">

## Sharing apps

Every app has an owner (whoever created it); admins can do everything with every app. In the builder's **Share** sheet the owner picks what the rest of the team gets (nothing, view, or edit) and adds people as viewers or editors:

- **Viewer**: opens the preview and the published app, and reads the builder (chat, code, data) without changing anything.
- **Editor**: also chats with the agent, edits code and preview data, restores versions and publishes.
- **Owner and admins**: also change live data, sharing and delete the app.

New apps start as view-only for the team; apps created before sharing existed stay editable by everyone. Traefik's sign-in check enforces the same rules on `<app>.<domain>` and `<app>-preview.<domain>`, and passes the role to apps as `X-Agency-App-Role` (`currentUser().appRole`).

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
