"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const envPath = ".env";
if (fs.existsSync(envPath)) {
  console.log(".env already exists. It was left unchanged.");
  process.exit(0);
}

const password = crypto.randomBytes(24).toString("base64url");
const values = [
  "NODE_ENV=development",
  "PORT=3001",
  "APP_URL=http://127.0.0.1:8000",
  "DATA_DIR=./data",
  `ADMIN_EMAIL=owner@localhost.test`,
  `ADMIN_PASSWORD=${password}`,
  `SESSION_SECRET=${crypto.randomBytes(48).toString("base64url")}`,
  `TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`,
  "LINKEDIN_API_VERSION=202611",
  "",
  "# Add the LinkedIn app credentials and callback URL to enable OAuth and publishing.",
  "LINKEDIN_CLIENT_ID=",
  "LINKEDIN_CLIENT_SECRET=",
  "LINKEDIN_REDIRECT_URI=",
  "",
  "# Optional AI-compatible provider (for example an OpenAI-compatible /v1 endpoint).",
  "AI_BASE_URL=",
  "AI_API_KEY=",
  "AI_MODEL=",
  "",
  "# Optional SMTP for reminders delivered while the dashboard is closed.",
  "SMTP_HOST=",
  "SMTP_PORT=587",
  "SMTP_SECURE=false",
  "SMTP_USER=",
  "SMTP_PASSWORD=",
  "SMTP_FROM=",
  "",
  "# Set true behind a single trusted HTTPS reverse proxy.",
  "TRUST_PROXY=false",
  "",
];

fs.writeFileSync(envPath, values.join("\n"), { flag: "wx", mode: 0o600 });
console.log("Created .env with unique local credentials. Open it to copy the generated ADMIN_EMAIL and ADMIN_PASSWORD for your first sign-in.");
console.log("Set up the social API, AI, and SMTP settings in .env when you are ready.");
