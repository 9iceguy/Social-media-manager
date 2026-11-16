# Socially

Socially is a single-user social media workspace with a React front end, an authenticated Node API, a persistent SQLite database, encrypted provider tokens, server-side scheduling, project file uploads, and an AI suggestion interface. The server is designed to run as one instance with a persistent data volume.

## Run locally

Requirements: Node.js 22.18+ and npm.

1. Install packages: `npm install`
2. Generate local-only secrets: `npm run setup`
3. Open `.env` and copy the generated `ADMIN_EMAIL` and `ADMIN_PASSWORD` for sign-in.
4. Start the API and React development server: `npm run dev`
5. Open <http://127.0.0.1:8000>.

`npm run build` type-checks and builds the React app. `npm start` serves the production build and API together on port 3001. `npm test` runs the provider tests.

The generated `.env` is ignored by Git. Back up the entire `data` directory and the `TOKEN_ENCRYPTION_KEY` together: the database contains encrypted access tokens that cannot be recovered if that key is lost. The JSON export contains workspace records but not uploaded file contents or provider tokens.

## LinkedIn connection and scheduled posts

1. Create a LinkedIn developer application and enable the required Sign In with LinkedIn using OpenID Connect and Share on LinkedIn products/permissions.
2. Request only `openid`, `profile`, and `w_member_social`. LinkedIn must grant the posting permission to the app; being able to sign in does not guarantee publishing access.
3. Configure the app's exact redirect URL as `https://YOUR_HOST/auth/linkedin/callback`.
4. Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, and `LINKEDIN_REDIRECT_URI` in `.env`, then restart the server.
5. Sign in, choose **Accounts → Connect LinkedIn**, and authorize Socially.
6. Create a post, select the connected LinkedIn profile, choose a future publish time, and set its status to **scheduled**.

The server queue continues while the browser is closed. LinkedIn text posts use LinkedIn's versioned Posts API. Expired tokens, API permissions, unsupported account types, and unsuccessful posts are marked as failed rather than reported as published. Reconnect the LinkedIn account and reschedule failed posts. The configured API version is `202611`; check LinkedIn's migration/version schedule before changing it.

## AI copilot

Suggestions are opt-in and use an OpenAI-compatible Chat Completions endpoint configured with `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL`. The server sends the workspace goal, audience, platform names, recent draft copy, and project progress to that provider. Do not enter sensitive personal or project details if you do not want them sent to your configured AI provider. The key stays on the server.

The copilot currently proposes ideas only. It cannot publish, contact people, or edit the workspace by itself. A human must save a suggestion as a draft and explicitly schedule it. The API and audit table are a deliberate seam for adding approved agent tools later.

## Server-side reminders

The scheduler runs independently of the browser. Due reminders are saved to the dashboard so they are visible the next time you open it. To receive email reminders for post times and contact follow-ups while away, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Reminders are sent to `ADMIN_EMAIL`. Contact date reminders are scheduled for 09:00 in the server's local timezone; set the host timezone appropriately.

## Deploy with Docker

Copy `.env.example` to `.env`, set unique `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET` (32+ random characters), `TOKEN_ENCRYPTION_KEY` (32 random bytes encoded as 64 hex characters), and the public `APP_URL`. Configure a persistent volume for `/data`, use HTTPS, set the exact public LinkedIn callback URL, then run:

```powershell
docker compose up --build -d
```

SQLite and the upload store are persistent in the Compose volume. Run one application replica; this deployment is for a personal workspace, not a horizontally scaled multi-tenant service. Keep `.env` and the volume private. Back up both the volume and encryption key.

## Platform support and boundaries

- **LinkedIn:** OAuth sign-in, text publishing, scheduled publishing, and token encryption are implemented. The LinkedIn app needs approval for the relevant product access. Member analytics require additional restricted access and are not enabled in this version.
- **Instagram, Facebook, X, TikTok, YouTube, and GitHub:** can be tracked manually. Each needs its own API app, granted permissions, and provider-specific implementation before live publishing, analytics, or messaging can be enabled. Provider adapters are kept separate to make those additions explicit.
- Posts are not sent as private messages. Networking is a contact/follow-up tracker; it does not automate outreach.
- Project attachments are stored on the server and served only to the authenticated workspace. Files are limited to 20 MB.
- The database is single-user. If you need accounts for multiple people or teams, add tenant-level authorization and database isolation before deployment.
