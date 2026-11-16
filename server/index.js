"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const SQLiteSessionStore = require("./session-store");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { z } = require("zod");
const { getProvider, getProviderCapabilities } = require("./providers/registry");

const PORT = Number(process.env.PORT || 3001);
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${PORT}`;
const DATABASE_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DATABASE_FILE = path.join(DATABASE_DIR, "socially.sqlite");
const UPLOAD_DIR = path.join(DATABASE_DIR, "uploads");
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || "202611";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

if (SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters. See .env.example.");
if (!/^[\da-f]{64}$/i.test(ENCRYPTION_KEY)) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters. See .env.example.");
if (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 12) throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.");

fs.mkdirSync(DATABASE_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DATABASE_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    account_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    expires_at TEXT,
    subject TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES social_accounts(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS social_accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    provider_subject TEXT,
    connected_at TEXT,
    UNIQUE(platform, provider_subject)
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    disk_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS delivery_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL UNIQUE,
    post_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    publish_at TEXT NOT NULL,
    status TEXT NOT NULL,
    remote_id TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminder_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    due_at TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

if (!db.prepare("PRAGMA table_info(reminder_jobs)").all().some((column) => column.name === "attempts")) {
  db.exec("ALTER TABLE reminder_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
}

if (!db.prepare("SELECT id FROM users LIMIT 1").get()) {
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
    crypto.randomUUID(), ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12), new Date().toISOString(),
  );
} else {
  db.prepare("UPDATE users SET email = ? WHERE email = 'owner@localhost' AND ? = 'owner@localhost.test' AND (SELECT COUNT(*) FROM users) = 1")
    .run(ADMIN_EMAIL, ADMIN_EMAIL);
}
if (!db.prepare("SELECT id FROM workspace WHERE id = 1").get()) {
  db.prepare("INSERT INTO workspace (id, revision, data) VALUES (1, 0, ?)").run(JSON.stringify(emptyWorkspace()));
}

function emptyWorkspace() {
  return {
    profile: { name: "", objective: "", audience: "", cadence: "", context: "" },
    accounts: [], posts: [], projects: [], contacts: [], notifications: [],
  };
}

function readWorkspace() {
  const record = db.prepare("SELECT revision, data FROM workspace WHERE id = 1").get();
  return { ...JSON.parse(record.data), revision: record.revision };
}

function writeWorkspace(data, expectedRevision) {
  const { revision: _revision, ...cleanData } = data;
  const result = db.prepare("UPDATE workspace SET data = ?, revision = revision + 1 WHERE id = 1 AND revision = ?")
    .run(JSON.stringify(cleanData), expectedRevision);
  if (!result.changes) return null;
  return readWorkspace();
}

const app = express();
const sessionStore = new SQLiteSessionStore(db);
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(session({
  name: "socially.sid",
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14,
  },
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
const userSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});
const profileSchema = z.object({
  name: z.string().max(120).default(""),
  objective: z.string().max(500).default(""),
  audience: z.string().max(500).default(""),
  cadence: z.string().max(150).default(""),
  context: z.string().max(3000).default(""),
});
const accountSchema = z.object({
  id: z.string().uuid(),
  platform: z.enum(["Instagram", "Facebook", "LinkedIn", "X", "GitHub", "TikTok", "YouTube", "Other"]),
  label: z.string().max(150).default(""),
  handle: z.string().max(500).default(""),
  goal: z.string().max(500).default(""),
  audienceSize: z.union([z.number().nonnegative(), z.literal("")]).default(""),
  target: z.union([z.number().nonnegative(), z.literal("")]).default(""),
  connected: z.boolean().default(false),
  connectedName: z.string().max(200).optional(),
});
const postSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(300).default(""),
  body: z.string().min(1).max(3000),
  objective: z.string().max(500).default(""),
  status: z.enum(["idea", "scheduled", "published", "failed"]),
  publishAt: z.string().max(60).default(""),
  remindAt: z.string().max(60).default(""),
  accountIds: z.array(z.string().uuid()).max(12).default([]),
  createdAt: z.string().max(60),
  result: z.string().max(500).optional(),
});
const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  category: z.string().max(150).default(""),
  status: z.enum(["In progress", "Planning", "On hold", "Complete"]),
  progress: z.number().min(0).max(100),
  dueDate: z.string().max(60).default(""),
  description: z.string().max(1500).default(""),
  update: z.string().max(3000).default(""),
  attachments: z.array(z.object({ id: z.string().uuid(), name: z.string().max(255), size: z.number().nonnegative() })).max(30).default([]),
});
const contactSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(150),
  role: z.string().max(150).default(""),
  company: z.string().max(150).default(""),
  channel: z.string().max(150).default(""),
  followUp: z.string().max(60).default(""),
  note: z.string().max(3000).default(""),
});
const workspaceSchema = z.object({
  profile: profileSchema.default({}),
  accounts: z.array(accountSchema).max(50),
  posts: z.array(postSchema).max(2000),
  projects: z.array(projectSchema).max(500),
  contacts: z.array(contactSchema).max(2000),
  notifications: z.array(z.object({
    id: z.string().uuid(), message: z.string().max(500), createdAt: z.string().max(60),
  })).max(100).default([]),
}).superRefine((workspace, context) => {
  const accountIds = new Set(workspace.accounts.map((account) => account.id));
  workspace.posts.forEach((post, index) => {
    if (post.accountIds.some((id) => !accountIds.has(id))) {
      context.addIssue({ code: "custom", path: ["posts", index, "accountIds"], message: "A post refers to an account that does not exist." });
    }
    if (post.status === "scheduled" && (!post.publishAt || Number.isNaN(Date.parse(post.publishAt)))) {
      context.addIssue({ code: "custom", path: ["posts", index, "publishAt"], message: "Scheduled posts need a valid publish time." });
    }
  });
});

function authenticated(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

function csrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const supplied = req.get("X-CSRF-Token") || "";
  const expected = req.session.csrfToken || "";
  if (!supplied || !expected || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ error: "Your session token expired. Refresh the page and try again." });
  }
  next();
}

app.get("/api/session", (req, res) => {
  res.json({ authenticated: Boolean(req.session.userId), email: req.session.email || "", csrfToken: req.session.csrfToken || "" });
});

app.post("/api/login", loginLimiter, async (req, res, next) => {
  try {
    const input = userSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: "Enter a valid email address and password." });
    const email = input.data.email.trim().toLowerCase();
    const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
    if (!user || !(await bcrypt.compare(input.data.password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.json({ authenticated: true, email: user.email, csrfToken: req.session.csrfToken });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api", authenticated, csrf);

app.post("/api/logout", authenticated, csrf, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("socially.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    res.status(204).end();
  });
});

app.post("/api/password", authenticated, csrf, async (req, res, next) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "New passwords must be at least 12 characters." });
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.session.userId);
    if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.password_hash))) {
      return res.status(401).json({ error: "Your current password is incorrect." });
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      await bcrypt.hash(parsed.data.newPassword, 12), req.session.userId,
    );
    return res.json({ changed: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/posts/:postId/retry", authenticated, csrf, (req, res) => {
  const workspace = readWorkspace();
  const post = workspace.posts.find((item) => item.id === req.params.postId);
  if (!post || post.status !== "failed") return res.status(404).json({ error: "No failed scheduled post was found." });
  const failedJobs = db.prepare("SELECT id FROM delivery_jobs WHERE post_id = ? AND status = 'failed'").all(post.id);
  if (!failedJobs.length) return res.status(409).json({ error: "There are no failed deliveries to retry." });
  const updated = writeWorkspace({
    ...workspace,
    posts: workspace.posts.map((item) => item.id === post.id ? { ...item, status: "scheduled", result: "" } : item),
  }, workspace.revision);
  if (!updated) return res.status(409).json({ error: "The workspace changed in another tab. Refresh and retry." });
  db.prepare("UPDATE delivery_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE post_id = ? AND status = 'failed'")
    .run(new Date().toISOString(), post.id);
  res.json({ workspace: updated });
  void processQueue();
});

app.get("/api/workspace", authenticated, (_req, res) => res.json({ workspace: readWorkspace() }));

app.put("/api/workspace", authenticated, csrf, (req, res) => {
  const expectedRevision = Number(req.body?.revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ error: "Workspace revision is required." });
  const parsed = workspaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Workspace data is invalid." });
  const trustedWorkspace = {
    ...parsed.data,
    accounts: parsed.data.accounts.map((account) => {
      const token = db.prepare("SELECT subject FROM oauth_tokens WHERE account_id = ?").get(account.id);
      return { ...account, connected: Boolean(token), connectedName: token ? account.connectedName || "" : "" };
    }),
  };
  const updated = writeWorkspace(trustedWorkspace, expectedRevision);
  if (!updated) return res.status(409).json({ error: "This workspace changed in another tab. The latest version has been loaded; try your change again." });
  syncSocialAccounts(updated.accounts);
  removeOrphanedFiles(updated.projects);
  enqueueWorkspaceReminders(updated);
  return res.json({ workspace: readWorkspace() });
});

app.post("/api/import/legacy", authenticated, csrf, (req, res) => {
  const parsed = workspaceSchema.safeParse({ ...req.body, notifications: [] });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "The previous workspace could not be imported." });
  const current = readWorkspace();
  if (current.revision !== 0 || current.accounts.length || current.posts.length || current.projects.length || current.contacts.length) {
    return res.json({ migrated: false });
  }
  const imported = {
    ...parsed.data,
    accounts: parsed.data.accounts.map((account) => ({ ...account, connected: false, connectedName: "" })),
    posts: parsed.data.posts.map((post) => ({ ...post, status: post.status === "scheduled" ? "idea" : post.status })),
    projects: parsed.data.projects.map((project) => ({ ...project, attachments: [] })),
  };
  const updated = writeWorkspace(imported, current.revision);
  if (!updated) return res.status(409).json({ error: "The workspace changed while importing. Refresh and retry." });
  syncSocialAccounts(updated.accounts);
  res.json({ migrated: true, workspace: updated });
});

app.get("/api/integrations", authenticated, (_req, res) => {
  res.json({
    linkedin: {
      configured: Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET && process.env.LINKEDIN_REDIRECT_URI),
      version: LINKEDIN_VERSION,
    },
    ai: { configured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL && process.env.AI_BASE_URL) },
    email: { configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM) },
    providers: getProviderCapabilities(),
  });
});

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decryptToken(value) {
  const packed = Buffer.from(value, "base64");
  if (packed.length < 29) throw new Error("Stored provider token is malformed.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

app.get("/auth/linkedin", authenticated, (req, res) => {
  const { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_REDIRECT_URI: redirectUri } = process.env;
  if (!clientId || !process.env.LINKEDIN_CLIENT_SECRET || !redirectUri) {
    return res.status(503).send("LinkedIn is not configured. Set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and LINKEDIN_REDIRECT_URI.");
  }
  const state = crypto.randomBytes(32).toString("base64url");
  req.session.linkedinState = state;
  const authorize = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", "openid profile w_member_social");
  res.redirect(authorize.toString());
});

app.get("/auth/linkedin/callback", authenticated, async (req, res, next) => {
  try {
    const state = String(req.query.state || "");
    const storedState = req.session.linkedinState || "";
    delete req.session.linkedinState;
    if (!state || !storedState || state.length !== storedState.length ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(storedState))) {
      return res.redirect(`${APP_URL}/?error=linkedin_state`);
    }
    if (req.query.error) return res.redirect(`${APP_URL}/?error=linkedin_denied`);
    const code = String(req.query.code || "");
    if (!code) return res.redirect(`${APP_URL}/?error=linkedin_code`);
    const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
      console.error("LinkedIn token exchange failed.", tokenData.error || tokenResponse.status);
      return res.redirect(`${APP_URL}/?error=linkedin_token`);
    }
    const identityResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    const identity = await identityResponse.json();
    if (!identityResponse.ok || typeof identity.sub !== "string") {
      console.error("LinkedIn profile lookup failed.", identityResponse.status);
      return res.redirect(`${APP_URL}/?error=linkedin_profile`);
    }
    const accountId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const accessExpiresAt = new Date(Date.now() + Number(tokenData.expires_in || 0) * 1000).toISOString();
    const displayName = [identity.given_name, identity.family_name].filter(Boolean).join(" ") || identity.name || "LinkedIn member";
    const existing = db.prepare("SELECT id FROM social_accounts WHERE platform = 'LinkedIn' AND provider_subject = ?").get(identity.sub);
    const selectedAccountId = existing?.id || accountId;
    db.transaction(() => {
      db.prepare(`INSERT INTO social_accounts (id, platform, provider_subject, connected_at) VALUES (?, 'LinkedIn', ?, ?)
        ON CONFLICT(platform, provider_subject) DO UPDATE SET connected_at = excluded.connected_at`).run(selectedAccountId, identity.sub, createdAt);
      db.prepare(`INSERT INTO oauth_tokens (account_id, provider, encrypted_token, expires_at, subject, created_at)
        VALUES (?, 'linkedin', ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, expires_at = excluded.expires_at, subject = excluded.subject`).run(
        selectedAccountId, encryptToken(tokenData.access_token), accessExpiresAt, identity.sub, createdAt,
      );
      const current = readWorkspace();
      const account = current.accounts.find((entry) => entry.id === selectedAccountId);
      const safeAccount = {
        id: selectedAccountId,
        platform: "LinkedIn",
        label: account?.label || displayName,
        handle: account?.handle || "",
        goal: account?.goal || "",
        audienceSize: account?.audienceSize || "",
        target: account?.target || "",
        connected: true,
        connectedName: displayName,
      };
      const next = { ...current, accounts: account
        ? current.accounts.map((entry) => entry.id === selectedAccountId ? safeAccount : entry)
        : [...current.accounts, safeAccount] };
      writeWorkspace(next, current.revision);
    })();
    return res.redirect(`${APP_URL}/?linkedin=connected`);
  } catch (error) {
    next(error);
  }
});

function syncSocialAccounts(accounts) {
  const upsert = db.prepare(`INSERT INTO social_accounts (id, platform, provider_subject, connected_at)
    VALUES (?, ?, NULL, NULL) ON CONFLICT(id) DO UPDATE SET platform = excluded.platform`);
  const remove = db.prepare("DELETE FROM social_accounts WHERE id = ?");
  const currentIds = new Set(accounts.map((account) => account.id));
  db.transaction(() => {
    for (const account of accounts) {
      if (!db.prepare("SELECT id FROM social_accounts WHERE id = ?").get(account.id)) upsert.run(account.id, account.platform);
    }
    const stored = db.prepare("SELECT id FROM social_accounts").all();
    for (const row of stored) {
      if (!currentIds.has(row.id)) remove.run(row.id);
    }
  })();
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, _file, callback) => callback(null, crypto.randomUUID()),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|application\/(vnd\.openxmlformats-officedocument\..+|msword|vnd\.ms-excel|vnd\.ms-powerpoint))$/i.test(file.mimetype);
    if (allowed) return callback(null, true);
    const error = new Error("Unsupported attachment type. Upload an image, PDF, text, or Office document.");
    error.status = 400;
    return callback(error);
  },
});

app.post("/api/projects/:projectId/files", authenticated, csrf, upload.single("file"), (req, res, next) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Choose a file to upload." });
    const workspace = readWorkspace();
    const project = workspace.projects.find((item) => item.id === req.params.projectId);
    if (!project) {
      unlinkUpload(file.path);
      return res.status(404).json({ error: "Project not found." });
    }
    const metadata = { id: crypto.randomUUID(), name: path.basename(file.originalname).slice(0, 255), size: file.size };
    const result = db.transaction(() => {
      const updated = writeWorkspace({
        ...workspace,
        projects: workspace.projects.map((item) => item.id === project.id ? { ...item, attachments: [...item.attachments, metadata] } : item),
      }, workspace.revision);
      if (!updated) return null;
      db.prepare("INSERT INTO files (id, project_id, disk_name, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(metadata.id, project.id, file.filename, metadata.name, file.mimetype, file.size, new Date().toISOString());
      return updated;
    })();
    if (!result) {
      unlinkUpload(file.path);
      return res.status(409).json({ error: "The workspace changed while uploading. Refresh and try again." });
    }
    res.status(201).json({ file: metadata });
  } catch (error) {
    if (req.file?.path) unlinkUpload(req.file.path);
    next(error);
  }
});

app.get("/api/files/:fileId", authenticated, (req, res, next) => {
  try {
    const file = db.prepare("SELECT disk_name, original_name, mime_type FROM files WHERE id = ?").get(req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found." });
    const filePath = path.join(UPLOAD_DIR, file.disk_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File content is unavailable." });
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.type(file.mime_type);
    return res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

app.get("/api/export", authenticated, (_req, res) => {
  const workspace = readWorkspace();
  res.setHeader("Content-Disposition", `attachment; filename="socially-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type("application/json").send(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), workspace }, null, 2));
});

app.post("/api/ai/suggestions", aiLimiter, authenticated, csrf, async (_req, res, next) => {
  const { AI_BASE_URL: baseUrl, AI_API_KEY: apiKey, AI_MODEL: model } = process.env;
  if (!baseUrl || !apiKey || !model) return res.status(503).json({ error: "AI suggestions are not configured. Set AI_BASE_URL, AI_API_KEY, and AI_MODEL on the server." });
  try {
    const workspace = readWorkspace();
    const activeProjects = workspace.projects.filter((project) => project.status !== "Complete").slice(0, 10);
    const recentPosts = workspace.posts.slice(-8).map((post) => ({ title: post.title, body: post.body, status: post.status }));
    const context = {
      goal: workspace.profile.objective,
      audience: workspace.profile.audience,
      cadence: workspace.profile.cadence,
      voiceAndContext: workspace.profile.context,
      accounts: workspace.accounts.map((account) => ({ platform: account.platform, handle: account.handle, goal: account.goal })),
      activeProjects: activeProjects.map((project) => ({ name: project.name, status: project.status, progress: project.progress, update: project.update })),
      recentPosts,
    };
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a careful social media strategy copilot. Give exactly 3 concise, specific post suggestions that align with the user's goal and audience. Adapt the format to each account platform. Never claim to have published, sent, or changed anything. Do not invent project facts. Return only JSON with shape {\"suggestions\":[{\"title\":\"...\",\"platform\":\"...\",\"objective\":\"...\",\"body\":\"...\",\"rationale\":\"...\"}]}. Use only platforms from the supplied account list; if none exist, use \"Other\"." },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) {
      console.error("AI provider returned an error.", response.status, result.error?.type || result.error?.message || "");
      return res.status(502).json({ error: "The configured AI provider rejected the request. Check the provider, key, model, and quota." });
    }
    const content = result.choices?.[0]?.message?.content;
    let decoded;
    try { decoded = JSON.parse(content); }
    catch { return res.status(502).json({ error: "The AI provider returned an invalid suggestion format. Try again." }); }
    const suggestions = z.array(z.object({
      title: z.string().min(1).max(200),
      platform: z.string().max(40),
      objective: z.string().max(200),
      body: z.string().min(1).max(3000),
      rationale: z.string().max(800),
    })).min(1).max(5).safeParse(decoded?.suggestions);
    if (!suggestions.success) return res.status(502).json({ error: "The AI provider returned incomplete suggestions. Try again." });
    const knownPlatforms = new Set(context.accounts.map((account) => account.platform));
    if (suggestions.data.some((suggestion) => suggestion.platform !== "Other" && !knownPlatforms.has(suggestion.platform))) {
      return res.status(502).json({ error: "The AI provider suggested a platform that is not in this workspace. Try again." });
    }
    db.prepare("INSERT INTO agent_audit (event, details, created_at) VALUES (?, ?, ?)")
      .run("suggestions_generated", JSON.stringify({ count: suggestions.data.length, model }), new Date().toISOString());
    return res.json({ suggestions: suggestions.data });
  } catch (error) {
    if (error.name === "TimeoutError") return res.status(504).json({ error: "The AI provider took too long to respond. Try again." });
    next(error);
  }
});

function linkedinConfigured() {
  return Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET && process.env.LINKEDIN_REDIRECT_URI);
}

function removeOrphanedFiles(projects) {
  const activeFileIds = new Set(projects.flatMap((project) => project.attachments.map((file) => file.id)));
  const files = db.prepare("SELECT id, disk_name FROM files").all();
  for (const file of files) {
    if (activeFileIds.has(file.id)) continue;
    db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
    unlinkUpload(path.join(UPLOAD_DIR, file.disk_name));
  }
}

function unlinkUpload(filePath) {
  fs.unlink(filePath, (error) => {
    if (error && error.code !== "ENOENT") console.error("Could not remove uploaded file.", error);
  });
}

function updatePostResult(postId, status, message) {
  const workspace = readWorkspace();
  const post = workspace.posts.find((item) => item.id === postId);
  if (!post) return;
  const otherJobs = db.prepare("SELECT status FROM delivery_jobs WHERE post_id = ?").all(postId);
  const allPublished = otherJobs.length > 0 && otherJobs.every((job) => job.status === "published");
  const hasFailure = otherJobs.some((job) => job.status === "failed");
  const updatedPost = {
    ...post,
    status: allPublished ? "published" : hasFailure ? "failed" : post.status,
    result: message.slice(0, 500),
  };
  writeWorkspace({ ...workspace, posts: workspace.posts.map((item) => item.id === postId ? updatedPost : item) }, workspace.revision);
}

function enqueueDuePosts() {
  const now = new Date().toISOString();
  const workspace = readWorkspace();
  const enqueue = db.prepare(`INSERT OR IGNORE INTO delivery_jobs (job_key, post_id, account_id, publish_at, status, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?)`);
  db.transaction(() => {
    for (const post of workspace.posts) {
      if (post.status !== "scheduled" || !post.publishAt || post.publishAt > now) continue;
      const selectedAccounts = workspace.accounts.filter((account) => post.accountIds.includes(account.id));
      if (!selectedAccounts.length) {
        const key = `${post.id}:no-account:${post.publishAt}`;
        enqueue.run(key, post.id, "no-account", post.publishAt, now);
        continue;
      }
      for (const account of selectedAccounts) {
        enqueue.run(`${post.id}:${account.id}:${post.publishAt}`, post.id, account.id, post.publishAt, now);
      }
    }
  })();
}

async function publishJob(job) {
  const claimed = db.prepare("UPDATE delivery_jobs SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), job.id);
  if (!claimed.changes) return;
  let success = false;
  let detail = "";
  let remoteId = null;
  try {
    const workspace = readWorkspace();
    const post = workspace.posts.find((item) => item.id === job.post_id);
    const account = workspace.accounts.find((item) => item.id === job.account_id);
    if (!post || !account) throw new Error("The post or account was removed before publishing.");
    if (job.account_id === "no-account") throw new Error("Choose a connected account before scheduling this post.");
    if (account.platform !== "LinkedIn") throw new Error(`${account.platform} publishing is not configured yet. This post was not sent.`);
    if (!linkedinConfigured()) throw new Error("LinkedIn API credentials are not configured on the server.");
    const connection = db.prepare("SELECT encrypted_token, expires_at, subject FROM oauth_tokens WHERE account_id = ?").get(account.id);
    if (!connection) throw new Error("LinkedIn account needs to be reconnected before publishing.");
    if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
      throw new Error("LinkedIn access expired. Reconnect this account before publishing.");
    }
    const accessToken = decryptToken(connection.encrypted_token);
    const result = await getProvider(account.platform).publish({ post, token: accessToken, subject: connection.subject });
    remoteId = result.remoteId;
    success = true;
    detail = result.detail;
  } catch (error) {
    detail = error instanceof Error ? error.message : "Publishing failed unexpectedly.";
    console.error("Scheduled post failed.", job.post_id, detail);
  }
  const status = success ? "published" : "failed";
  db.prepare("UPDATE delivery_jobs SET status = ?, remote_id = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(status, remoteId, success ? null : detail, new Date().toISOString(), job.id);
  updatePostResult(job.post_id, status, detail);
}

function enqueueWorkspaceReminders(workspace) {
  const now = new Date().toISOString();
  const notifications = [];
  const enqueue = db.prepare(`INSERT OR IGNORE INTO reminder_jobs (job_key, kind, due_at, subject, body, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
  db.transaction(() => {
    for (const post of workspace.posts) {
      if (post.status === "published" || !post.remindAt || post.remindAt > now) continue;
      const title = post.title || firstLine(post.body) || "Planned social post";
      const result = enqueue.run(`${post.id}:post:${post.remindAt}`, "post", post.remindAt, `Socially reminder: ${title}`, post.body, now);
      if (result.changes) notifications.push({ id: crypto.randomUUID(), message: `Post reminder: ${title}`, createdAt: now });
    }
    for (const contact of workspace.contacts) {
      if (!contact.followUp) continue;
      const dueAt = new Date(`${contact.followUp}T09:00:00`).toISOString();
      if (dueAt > now) continue;
      const result = enqueue.run(`${contact.id}:contact:${contact.followUp}`, "contact", dueAt,
        `Socially networking follow-up: ${contact.name}`, contact.note || `Reconnect with ${contact.name}.`, now);
      if (result.changes) notifications.push({ id: crypto.randomUUID(), message: `Networking follow-up: reconnect with ${contact.name}.`, createdAt: now });
    }
  })();
  if (notifications.length) {
    writeWorkspace({
      ...workspace,
      notifications: [...workspace.notifications, ...notifications].slice(-100),
    }, workspace.revision);
  }
}

async function sendReminder(job) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM || !ADMIN_EMAIL) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } : undefined,
  });
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM, to: ADMIN_EMAIL, subject: job.subject, text: job.body });
    db.prepare("UPDATE reminder_jobs SET status = 'sent', error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Email delivery failed.";
    db.prepare(`UPDATE reminder_jobs SET attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
      error = ?, updated_at = ? WHERE id = ?`)
      .run(message, new Date().toISOString(), job.id);
    console.error("Email reminder delivery failed.", message);
  } finally {
    transporter.close();
  }
}

async function processQueue() {
  try {
    const stuck = db.prepare("SELECT id, post_id FROM delivery_jobs WHERE status = 'sending' AND updated_at < ?")
      .all(new Date(Date.now() - 5 * 60 * 1000).toISOString());
    for (const job of stuck) {
      db.prepare("UPDATE delivery_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
        .run("The server stopped while publishing. Check LinkedIn before retrying to avoid duplicate posts.", new Date().toISOString(), job.id);
      updatePostResult(job.post_id, "failed", "The server stopped while publishing. Check LinkedIn before retrying to avoid duplicate posts.");
    }
    enqueueDuePosts();
    enqueueWorkspaceReminders(readWorkspace());
    const posts = db.prepare("SELECT * FROM delivery_jobs WHERE status = 'pending' ORDER BY publish_at LIMIT 10").all();
    for (const job of posts) await publishJob(job);
    const retryBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const reminders = db.prepare(`SELECT * FROM reminder_jobs WHERE status = 'pending' AND attempts < 5
      AND (error IS NULL OR updated_at < ?) ORDER BY due_at LIMIT 10`).all(retryBefore);
    for (const reminder of reminders) await sendReminder(reminder);
  } catch (error) {
    console.error("Background scheduler iteration failed.", error);
  }
}

const frontendPath = path.resolve(__dirname, "../dist");
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath, { index: false, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) return next();
    return res.sendFile(path.join(frontendPath, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Files must be 20 MB or smaller." : "The file upload could not be processed.";
    return res.status(400).json({ error: message });
  }
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || "Invalid input." });
  if (error.status && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: error.message || "Invalid request." });
  }
  console.error("Request failed.", error);
  return res.status(500).json({ error: "The server could not complete the request." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Socially API listening on port ${PORT}`);
  void processQueue();
  setInterval(processQueue, 15000).unref();
  setInterval(() => sessionStore.clearExpired(), 60 * 60 * 1000).unref();
});
