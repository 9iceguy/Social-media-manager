import { useCallback, useEffect, useState } from "react";
import type { ButtonHTMLAttributes, FormEvent, MouseEvent, ReactNode } from "react";
import { emptyWorkspace, PLATFORMS } from "./types";
import type { Account, Contact, Post, Project, Workspace } from "./types";

type Page = "overview" | "planner" | "projects" | "network" | "accounts" | "agent";
type RecordType = "account" | "post" | "project" | "contact" | "profile";
type Editor = { type: RecordType; item?: Record<string, unknown> } | null;
type Session = { authenticated: boolean; email?: string; csrfToken?: string };
type Suggestion = { title: string; platform: string; objective: string; body: string; rationale: string };

const pageTitles: Record<Page, string> = {
  overview: "Overview",
  planner: "Content planner",
  projects: "Projects",
  network: "Network",
  accounts: "Accounts",
  agent: "AI copilot",
};
const platformMarks: Record<string, string> = {
  Instagram: "ig", Facebook: "f", LinkedIn: "in", X: "𝕏", GitHub: "gh", TikTok: "♪", YouTube: "▶", Other: "↗",
};

async function request<T>(path: string, csrfToken?: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (csrfToken && init?.method && init.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function readLegacyAttachment(id: string): Promise<File | null> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }
    const opening = indexedDB.open("socially.attachments.v1");
    opening.onerror = () => reject(opening.error || new Error("Could not open the previous attachment store."));
    opening.onsuccess = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains("files")) {
        database.close();
        resolve(null);
        return;
      }
      const transaction = database.transaction("files", "readonly");
      const read = transaction.objectStore("files").get(id);
      read.onsuccess = () => {
        database.close();
        resolve(read.result instanceof File ? read.result : null);
      };
      read.onerror = () => {
        database.close();
        reject(read.error || new Error("Could not read the previous attachment."));
      };
    };
  });
}

function uid(): string {
  return crypto.randomUUID();
}

function formatDate(value: string, withTime = false): string {
  if (!value) return "No date set";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "No date set";
  return new Intl.DateTimeFormat(undefined, withTime
    ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
}

function toLocalDateTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function initials(value: string): string {
  return value.trim().split(/\s+/).slice(0, 2).map((word) => word[0] || "").join("").toUpperCase() || "?";
}

function Button({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props}>{children}</button>;
}

function Heading({ title, description, action, onAction }: {
  title: string; description: string; action?: string; onAction?: () => void;
}) {
  return <div className="page-heading"><div><p className="eyebrow">YOUR SOCIAL WORKSPACE</p><h1>{title}</h1><p>{description}</p></div>
    {action && <Button className="button-primary" onClick={onAction}>＋ {action}</Button>}</div>;
}

function Empty({ title, children, action, onAction }: {
  title: string; children: ReactNode; action: string; onAction: () => void;
}) {
  return <div className="empty-state"><strong>{title}</strong>{children}<br /><Button className="button-primary button-small" onClick={onAction}>{action}</Button></div>;
}

function Stat({ label, value, note, icon }: { label: string; value: string | number; note: string; icon: string }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div>
    <div className="stat-value">{value}</div><div className="stat-foot">{note}</div></article>;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace());
  const [page, setPage] = useState<Page>("overview");
  const [editor, setEditor] = useState<Editor>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionError, setSuggestionError] = useState("");
  const [passwordDialog, setPasswordDialog] = useState(false);
  const [startupError, setStartupError] = useState("");

  const notify = useCallback((text: string, error = false) => {
    setNotice({ text, error });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 5000);
  }, []);

  const refreshWorkspace = useCallback(async () => {
    const result = await request<{ workspace: Workspace }>("/api/workspace");
    setWorkspace(result.workspace);
  }, []);

  useEffect(() => {
    let active = true;
    request<Session>("/api/session").then(async (result) => {
      if (!active) return;
      setSession(result);
      if (result.authenticated) {
        await refreshWorkspace();
        await migrateLegacyWorkspace(result.csrfToken || "");
        if (window.location.search.includes("linkedin=connected")) {
          notify("LinkedIn is connected and ready to publish.", false);
          window.history.replaceState({}, "", window.location.pathname);
        } else if (window.location.search.includes("error=")) {
          notify("LinkedIn could not connect. Check the app permissions and callback URL.", true);
          window.history.replaceState({}, "", window.location.pathname);
        }
      }
    }).catch((error: unknown) => {
      setSession({ authenticated: false });
      setStartupError(error instanceof Error ? error.message : "Could not connect to the server.");
    });
    return () => { active = false; };
  }, [notify, refreshWorkspace]);

  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !document.querySelector("dialog[open]")) {
        void refreshWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : "Could not refresh the workspace.", true));
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [notify, refreshWorkspace, session?.authenticated]);

  const persist = useCallback(async (next: Workspace) => {
    if (!session?.csrfToken) throw new Error("Your session expired. Sign in again.");
    setBusy(true);
    try {
      const saved = await request<{ workspace: Workspace }>("/api/workspace", session.csrfToken, {
        method: "PUT",
        body: JSON.stringify({ ...next, revision: workspace.revision }),
      });
      setWorkspace(saved.workspace);
      return saved.workspace;
    } catch (error) {
      if (error instanceof Error && error.message.includes("changed in another tab")) {
        await refreshWorkspace();
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }, [refreshWorkspace, session, workspace.revision]);

  async function migrateLegacyWorkspace(csrfToken: string) {
    const legacy = localStorage.getItem("socially.workspace.v1");
    if (!legacy || localStorage.getItem("socially.migrated.v1")) return;
    try {
      const old = JSON.parse(legacy) as Partial<Workspace>;
      if (!Array.isArray(old.accounts) && !Array.isArray(old.posts)) return;
      const result = await request<{ migrated: boolean; workspace?: Workspace }>("/api/import/legacy", csrfToken, {
        method: "POST",
        body: JSON.stringify(old),
      });
      if (result.migrated && result.workspace) {
        let missingFiles = 0;
        for (const project of old.projects || []) {
          for (const attachment of project.attachments || []) {
            const file = await readLegacyAttachment(attachment.id);
            if (!file) {
              missingFiles += 1;
              continue;
            }
            const upload = new FormData();
            upload.append("file", file, attachment.name);
            await request(`/api/projects/${encodeURIComponent(project.id)}/files`, csrfToken, { method: "POST", body: upload });
          }
        }
        localStorage.setItem("socially.migrated.v1", "true");
        await refreshWorkspace();
        notify(missingFiles
          ? `Your previous workspace was imported. ${missingFiles} attachment(s) were unavailable in this browser.`
          : "Your previous browser workspace has been moved to the server.");
      }
    } catch (error) {
      notify(error instanceof Error ? `Previous workspace was not imported: ${error.message}` : "Previous workspace import failed.", true);
    }
  }

  const saveEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = Object.fromEntries(data.entries()) as Record<string, string>;
    const type = editor.type;
    const existing = editor.item || {};
    const id = String(existing.id || uid());
    const update = <T extends { id: string }>(items: T[], record: T): T[] =>
      items.some((item) => item.id === record.id) ? items.map((item) => item.id === record.id ? record : item) : [...items, record];

    try {
      let next: Workspace = workspace;
      if (type === "profile") {
        next = { ...workspace, profile: {
          name: values.name.trim(), objective: values.objective.trim(), audience: values.audience.trim(),
          cadence: values.cadence.trim(), context: values.context.trim(),
        } };
      } else if (type === "account") {
        const account: Account = {
          id, platform: values.platform as Account["platform"], label: values.label.trim() || values.platform,
          handle: values.handle.trim(), goal: values.goal.trim(),
          audienceSize: values.audienceSize ? Number(values.audienceSize) : "",
          target: values.target ? Number(values.target) : "", connected: Boolean(existing.connected),
          connectedName: String(existing.connectedName || ""),
        };
        next = { ...workspace, accounts: update(workspace.accounts, account) };
      } else if (type === "post") {
        const post: Post = {
          id, title: values.title.trim(), body: values.body.trim(), objective: values.objective.trim(),
          status: values.status as Post["status"], publishAt: values.publishAt ? new Date(values.publishAt).toISOString() : "",
          remindAt: values.remindAt ? new Date(values.remindAt).toISOString() : "",
          accountIds: data.getAll("accountIds").map(String), createdAt: String(existing.createdAt || new Date().toISOString()),
          result: String(existing.result || ""),
        };
        next = { ...workspace, posts: update(workspace.posts, post) };
      } else if (type === "project") {
        const project: Project = {
          id, name: values.name.trim(), category: values.category.trim(),
          status: values.status as Project["status"], progress: Math.max(0, Math.min(100, Number(values.progress) || 0)),
          dueDate: values.dueDate, description: values.description.trim(), update: values.update.trim(),
          attachments: (existing.attachments as Project["attachments"]) || [],
        };
        next = { ...workspace, projects: update(workspace.projects, project) };
      } else {
        const contact: Contact = {
          id, name: values.name.trim(), role: values.role.trim(), company: values.company.trim(),
          channel: values.channel.trim(), followUp: values.followUp, note: values.note.trim(),
        };
        next = { ...workspace, contacts: update(workspace.contacts, contact) };
      }
      const saved = await persist(next);
      if (type === "project") {
        const files = data.getAll("attachments").filter((file): file is File => file instanceof File && file.size > 0);
        for (const file of files) {
          const upload = new FormData();
          upload.append("file", file);
          await request(`/api/projects/${encodeURIComponent(id)}/files`, session?.csrfToken, { method: "POST", body: upload });
        }
        if (files.length) await refreshWorkspace();
      }
      setEditor(null);
      notify(`${type[0].toUpperCase()}${type.slice(1)} saved.`);
      if (type === "post" && values.status === "scheduled" && values.remindAt) notify("Post scheduled. Email reminders are sent by the server when SMTP is configured.");
      void saved;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save your changes.", true);
    }
  };

  async function removeRecord(type: "accounts" | "posts" | "projects" | "contacts", id: string) {
    if (!window.confirm(`Remove this ${type.slice(0, -1)}? This cannot be undone.`)) return;
    const next = { ...workspace, [type]: workspace[type].filter((item) => item.id !== id) } as Workspace;
    if (type === "accounts") next.posts = next.posts.map((post) => ({ ...post, accountIds: post.accountIds.filter((accountId) => accountId !== id) }));
    try {
      await persist(next);
      notify("Item removed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not remove the item.", true);
    }
  }

  async function requestSuggestions() {
    setBusy(true);
    setSuggestionError("");
    try {
      const response = await request<{ suggestions: Suggestion[] }>("/api/ai/suggestions", session?.csrfToken, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSuggestions(response.suggestions);
    } catch (error) {
      setSuggestionError(error instanceof Error ? error.message : "The AI assistant is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function createPostFromSuggestion(suggestion: Suggestion) {
    const post: Post = {
      id: uid(), title: suggestion.title, body: suggestion.body, objective: suggestion.objective,
      status: "idea", publishAt: "", remindAt: "",
      accountIds: workspace.accounts.filter((account) => account.platform === suggestion.platform).map((account) => account.id),
      createdAt: new Date().toISOString(),
    };
    try {
      await persist({ ...workspace, posts: [...workspace.posts, post] });
      setPage("planner");
      notify("Suggestion saved as a draft. Review it before publishing.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save the suggestion.", true);
    }
  }

  async function retryPost(postId: string) {
    try {
      const result = await request<{ workspace: Workspace }>(`/api/posts/${encodeURIComponent(postId)}/retry`, session?.csrfToken, {
        method: "POST",
        body: "{}",
      });
      setWorkspace(result.workspace);
      notify("Failed delivery queued for retry. Check the planner for its result.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not retry this post.", true);
    }
  }

  async function clearNotifications() {
    try {
      await persist({ ...workspace, notifications: [] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not clear reminders.", true);
    }
  }

  async function logout() {
    try {
      await request("/api/logout", session?.csrfToken, { method: "POST", body: "{}" });
      setSession({ authenticated: false });
      setWorkspace(emptyWorkspace());
      setPage("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not sign out.", true);
    }
  }

  async function downloadFile(attachmentId: string, name: string) {
    const response = await fetch(`/api/files/${encodeURIComponent(attachmentId)}`, { credentials: "same-origin" });
    if (!response.ok) {
      notify("Could not download this file.", true);
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const openNew = (type: RecordType) => setEditor({ type });
  const openEdit = (type: RecordType, item: Record<string, unknown>) => setEditor({ type, item });

  if (!session) return <div className="boot-screen">Starting your secure workspace…</div>;
  if (!session.authenticated) return <Login initialError={startupError} onLogin={async (result) => {
    setSession(result);
    await refreshWorkspace();
    await migrateLegacyWorkspace(result.csrfToken || "");
  }} />;

  const scheduledPosts = workspace.posts.filter((post) => post.status === "scheduled");
  const publishedPosts = workspace.posts.filter((post) => post.status === "published");
  const followUps = workspace.contacts.filter((contact) => contact.followUp && contact.followUp >= new Date().toISOString().slice(0, 10)).length;
  const profileName = workspace.profile.name.trim();

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage("overview"); }}><span className="brand-mark">s.</span><span>socially<span className="brand-period">.</span></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">
        {(["overview", "planner", "projects", "network", "accounts", "agent"] as Page[]).map((key) =>
          <button key={key} className={`nav-link ${page === key ? "active" : ""}`} onClick={() => setPage(key)}>
            <span className="nav-icon">{({ overview: "⌂", planner: "▦", projects: "◫", network: "◎", accounts: "◉", agent: "✳" })[key]}</span>{pageTitles[key]}
          </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="privacy-note"><span className="privacy-dot"></span><span>Server-backed workspace<br /><small>Private to your signed-in account</small></span></div>
        <button className="nav-link" onClick={() => { window.location.href = "/api/export"; }}><span className="nav-icon">⇩</span>Export backup</button>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{pageTitles[page]}</strong></div>
        <div className="topbar-actions"><span className="session-email">{session.email}</span><button className="button button-quiet button-small password-button" onClick={() => setPasswordDialog(true)}>Change password</button><button className="avatar" onClick={logout} title="Sign out">{initials(profileName || session.email || "Y")}</button></div>
      </header>
      {notice && <div className={`toast${notice.error ? " error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}</div>}
      <div className="page-content">
        {page === "overview" && <>
          <Heading title={`Welcome${profileName ? `, ${profileName.split(" ")[0]}` : " back"}`} description="Build a consistent presence and keep your relationships moving." action="Plan a post" onAction={() => openNew("post")} />
          <section className="goal-banner"><div className="goal-copy"><span className="goal-symbol">✳</span><div><strong>Your north star</strong><span>{workspace.profile.objective || "Set a clear goal to focus your content."}{workspace.profile.audience ? ` · For ${workspace.profile.audience}` : ""}</span></div></div><Button className="button-quiet button-small" onClick={() => openEdit("profile", workspace.profile as unknown as Record<string, unknown>)}>Edit strategy</Button></section>
          <section className="stats-grid"><Stat label="Social accounts" value={workspace.accounts.length} note="Across your channels" icon="◎" /><Stat label="Posts published" value={publishedPosts.length} note="Tracked and published" icon="↗" /><Stat label="Projects in motion" value={workspace.projects.filter((project) => project.status !== "Complete").length} note="With progress updates" icon="◫" /><Stat label="People to follow up" value={followUps} note="Networking reminders" icon="♡" /></section>
          <section className="dashboard-grid">
            <Panel title="Coming up" subtitle="Your next planned posts" action="View planner →" onAction={() => setPage("planner")}>
              {scheduledPosts.length ? scheduledPosts.slice().sort((a, b) => a.publishAt.localeCompare(b.publishAt)).slice(0, 4).map((post) =>
                <div className="list-row" key={post.id}><span className="platform-badge">{platformMarks[workspace.accounts.find((account) => post.accountIds.includes(account.id))?.platform || "Other"]}</span><div className="row-main"><strong>{post.title || firstLine(post.body) || "Untitled post"}</strong><span>{accountNames(post.accountIds, workspace.accounts) || "No account selected"} · {post.objective || "General update"}</span></div><span className="row-trailing">{formatDate(post.publishAt)}</span></div>
              ) : <Empty title="Nothing scheduled yet" action="Plan a post" onAction={() => openNew("post")}>Add a post to start building a consistent rhythm.</Empty>}
            </Panel>
            <Panel title="Project pulse" subtitle="Keep your progress visible" action="All projects →" onAction={() => setPage("projects")}>
              {workspace.projects.filter((project) => project.status !== "Complete").length ? workspace.projects.filter((project) => project.status !== "Complete").slice(0, 3).map((project) =>
                <div key={project.id}><div className="list-row"><span className="platform-badge">◫</span><div className="row-main"><strong>{project.name}</strong><span>{project.status}</span></div><span className="row-trailing">{project.progress}%</span></div><div className="goal-progress"><Progress value={project.progress} /></div></div>
              ) : <Empty title="No projects yet" action="Add a project" onAction={() => openNew("project")}>Track launches and progress updates in one place.</Empty>}
            </Panel>
          </section>
          {workspace.notifications.length > 0 && <div className="panel reminder-panel"><div className="panel-header"><div><h2>Reminders</h2><p>Saved on the server while you were away</p></div><button className="text-button" onClick={() => void clearNotifications()}>Clear all</button></div><div className="panel-body">{workspace.notifications.slice().reverse().slice(0, 5).map((notification) => <div className="list-row" key={notification.id}><span className="platform-badge">◷</span><div className="row-main"><strong>{notification.message}</strong><span>{formatDate(notification.createdAt, true)}</span></div></div>)}</div></div>}
          <div className="reminder-note"><strong>Automations:</strong> Scheduled publishing and email reminders run on the server. They require a connected platform and configured SMTP delivery.</div>
        </>}

        {page === "planner" && <><Heading title="Content planner" description="Draft, get AI suggestions, schedule, and publish after review." action="Create a post" onAction={() => openNew("post")} />
          {workspace.posts.length ? <div className="content-list">{workspace.posts.slice().sort((a, b) => (a.publishAt || a.createdAt).localeCompare(b.publishAt || b.createdAt)).map((post) =>
            <article className="content-card" key={post.id}><span className="content-accent"></span><div className="content-details"><div className="content-meta"><span className={`status-pill ${post.status}`}>{post.status === "failed" ? "Needs attention" : capitalize(post.status)}</span><span>{accountNames(post.accountIds, workspace.accounts) || "No accounts"}</span><span>{post.publishAt ? formatDate(post.publishAt, true) : "Unscheduled"}</span></div><h3>{post.title || firstLine(post.body) || "Untitled post"}</h3><p>{post.body}</p>{post.result && <p className="post-result">{post.result}</p>}<div className="content-meta">{post.objective && <span>Goal: {post.objective}</span>}{post.remindAt && <span>Reminder: {formatDate(post.remindAt, true)}</span>}</div></div><div className="card-actions">{post.status === "failed" && <button className="button button-quiet button-small" onClick={() => void retryPost(post.id)}>Retry failed</button>}<button className="tiny-action" aria-label="Edit post" onClick={() => openEdit("post", post as unknown as Record<string, unknown>)}>✎</button><button className="tiny-action" aria-label="Delete post" onClick={() => void removeRecord("posts", post.id)}>×</button></div></article>
          )}</div> : <div className="panel"><Empty title="Your planner is ready" action="Create your first post" onAction={() => openNew("post")}>Draft ideas, set reminders, and tailor posts to your objectives.</Empty></div>}
          <div className="reminder-note"><strong>Publishing safety:</strong> posts are sent only at their scheduled time to connected accounts. Review drafts carefully before scheduling.</div>
        </>}

        {page === "accounts" && <>
          <Heading title="Your accounts" description="Connect LinkedIn for publishing; other platforms are ready for future adapters." action="Add a tracker" onAction={() => openNew("account")} />
          <div className="panel integration-banner"><div><strong>LinkedIn publishing</strong><span>Connect your profile using LinkedIn's secure OAuth consent screen.</span></div>
            <Button className="button-primary" onClick={() => { window.location.href = "/auth/linkedin"; }}>Connect LinkedIn</Button></div>
          <div className="reminder-note integration-note"><strong>Platform access:</strong> X, Instagram, Facebook, TikTok, and YouTube require their own developer apps and permissions. They are tracked here but not connected until their adapters and credentials are configured. GitHub publishing is designed for project updates, not general social posts.</div>
          {workspace.accounts.length ? <div className="account-grid">{workspace.accounts.map((account) =>
            <article className="surface-card account-card" key={account.id}><div className="account-top"><span className="platform-badge">{platformMarks[account.platform] || "↗"}</span><div className="account-title"><strong>{account.label || account.platform}</strong><span>{account.handle || account.connectedName || "No handle"} · {account.platform}</span></div><span className={`status-pill ${account.connected ? "active" : ""}`}>{account.connected ? "Connected" : "Manual"}</span></div>
              <div className="account-metrics"><Metric value={String(account.audienceSize || "—")} label="Audience" /><Metric value={String(account.target || "—")} label="Target" /><Metric value={String(workspace.posts.filter((post) => post.accountIds.includes(account.id)).length)} label="Planned posts" /></div>
              <div className="goal-progress account-target"><div className="goal-progress-label"><span>{account.goal || "Growth objective"}</span><strong>{account.audienceSize && account.target ? `${Math.min(100, Math.round(Number(account.audienceSize) / Math.max(1, Number(account.target)) * 100))}%` : "Set target"}</strong></div><Progress value={account.audienceSize && account.target ? Math.min(100, Number(account.audienceSize) / Number(account.target) * 100) : 0} /></div>
              <div className="card-actions account-actions"><button className="button button-quiet button-small" onClick={() => openEdit("account", account as unknown as Record<string, unknown>)}>Edit</button><button className="button button-quiet button-small" onClick={() => void removeRecord("accounts", account.id)}>Remove</button></div>
            </article>)}</div> : <div className="panel"><Empty title="Bring your channels together" action="Add your first account" onAction={() => openNew("account")}>Track your goals and organize your content plans in one place.</Empty></div>}
        </>}

        {page === "projects" && <><Heading title="Projects & progress" description="Track milestones, updates, and project files in persistent server storage." action="Add a project" onAction={() => openNew("project")} />
          {workspace.projects.length ? <div className="project-grid">{workspace.projects.map((project) =>
            <article className="surface-card project-card" key={project.id}><div className="project-card-top"><div><p className="eyebrow">{project.category || "PROJECT"}</p><h3>{project.name}</h3></div><div className="card-actions"><button className="tiny-action" aria-label="Edit project" onClick={() => openEdit("project", project as unknown as Record<string, unknown>)}>✎</button><button className="tiny-action" aria-label="Delete project" onClick={() => void removeRecord("projects", project.id)}>×</button></div></div><p>{project.update || project.description || "Add a project update."}</p><Progress value={project.progress} /><div className="project-foot"><span>{project.status}</span><strong>{project.progress}% complete</strong></div>{project.dueDate && <div className="project-foot"><span>Milestone</span><span>{formatDate(project.dueDate)}</span></div>}
              {project.attachments.map((file) => <button className="attachment-link" key={file.id} onClick={() => void downloadFile(file.id, file.name)}>↧ {file.name}</button>)}
            </article>)}</div> : <div className="panel"><Empty title="Give your progress a home" action="Create a project" onAction={() => openNew("project")}>Track project milestones, share updates, and keep supporting files close by.</Empty></div>}
        </>}

        {page === "network" && <><Heading title="Network" description="Remember conversations and follow up on time." action="Add a contact" onAction={() => openNew("contact")} />
          {workspace.contacts.length ? <div className="contact-grid">{workspace.contacts.slice().sort((a, b) => (a.followUp || "9999").localeCompare(b.followUp || "9999")).map((contact) =>
            <article className="surface-card contact-card" key={contact.id}><div className="contact-top"><span className="contact-avatar">{initials(contact.name)}</span><div className="contact-info"><strong>{contact.name}</strong><span>{[contact.role, contact.company].filter(Boolean).join(" · ") || "Connection"}</span></div><div className="card-actions"><button className="tiny-action" aria-label="Edit contact" onClick={() => openEdit("contact", contact as unknown as Record<string, unknown>)}>✎</button><button className="tiny-action" aria-label="Delete contact" onClick={() => void removeRecord("contacts", contact.id)}>×</button></div></div><p>{contact.note || "Add a note about your last conversation."}</p><div className="contact-foot"><span>{contact.channel || "Connection"}</span><span>{contact.followUp ? `Follow up ${formatDate(contact.followUp)}` : "No follow-up set"}</span></div></article>
          )}</div> : <div className="panel"><Empty title="Make networking more intentional" action="Add your first contact" onAction={() => openNew("contact")}>Keep conversation context and set dates to reconnect.</Empty></div>}
        </>}

        {page === "agent" && <><Heading title="AI copilot" description="Get goal-aware suggestions for content and next steps. Nothing is published or changed without your approval." />
          <div className="panel agent-panel"><div className="panel-header"><div><h2>Your strategy assistant</h2><p>Suggestions use your goals, audience, active projects, and tracked channels.</p></div><Button className="button-primary" onClick={() => void requestSuggestions()} disabled={busy}>{busy ? "Thinking…" : "✳ Get suggestions"}</Button></div>
            <div className="panel-body">{suggestionError && <p className="form-error agent-error">{suggestionError}</p>}{suggestions.length ? <div className="suggestion-grid">{suggestions.map((suggestion, index) =>
              <article className="surface-card suggestion-card" key={`${suggestion.platform}-${index}`}><div className="content-meta"><span className="status-pill">{suggestion.platform}</span><span>{suggestion.objective}</span></div><h3>{suggestion.title}</h3><p>{suggestion.body}</p><div className="reminder-note"><strong>Why it may help:</strong> {suggestion.rationale}</div><Button className="button-quiet" onClick={() => void createPostFromSuggestion(suggestion)}>Save as draft</Button></article>
            )}</div> : <Empty title="Make your goals actionable" action={busy ? "Working…" : "Get AI suggestions"} onAction={() => void requestSuggestions()}>The assistant can propose post ideas, a weekly rhythm, and project update angles. Configure an AI-compatible provider to enable it.</Empty>}</div>
          </div>
          <div className="reminder-note"><strong>Human in the loop:</strong> the assistant only creates suggestions. You choose whether to save a draft, schedule it, or publish it.</div>
        </>}
      </div>
    </main>
    {editor && <EditorDialog type={editor.type} item={editor.item} workspace={workspace} busy={busy} onClose={() => setEditor(null)} onSubmit={saveEditor} />}
    {passwordDialog && <PasswordDialog csrfToken={session.csrfToken || ""} onClose={() => setPasswordDialog(false)} notify={notify} />}
  </div>;
}

function Login({ onLogin, initialError }: { onLogin: (session: Session) => Promise<void>; initialError: string }) {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState(initialError);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setErrorMessage("");
    try {
      const result = await request<Session>("/api/login", undefined, { method: "POST", body: JSON.stringify({ email, password }) });
      await onLogin(result);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setLoading(false);
    }
  };
  return <main className="login-screen"><form className="login-card" onSubmit={submit}><a className="brand login-brand" href="#"><span className="brand-mark">s.</span><span>socially<span className="brand-period">.</span></span></a><p className="eyebrow">PRIVATE WORKSPACE</p><h1>Welcome back</h1><p className="login-subtitle">Sign in to manage your social channels.</p>{errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}<Field label="Email" name="email" type="email" value={email} onChange={(value) => setEmail(value)} required /><Field label="Password" name="password" type="password" value={password} onChange={(value) => setPassword(value)} required /><Button className="button-primary login-submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</Button></form></main>;
}

function accountNames(ids: string[], accounts: Account[]): string {
  return ids.map((id) => accounts.find((account) => account.id === id)?.platform).filter(Boolean).join(", ");
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function Panel({ title, subtitle, action, onAction, children }: { title: string; subtitle: string; action: string; onAction: () => void; children: ReactNode }) {
  return <div className="panel"><div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="text-button" onClick={onAction}>{action}</button></div><div className="panel-body">{children}</div></div>;
}

function Progress({ value }: { value: number }) {
  return <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="account-metric"><strong>{value}</strong>{label}</div>;
}

function Field({ label, name, type = "text", value, required, placeholder, onChange, min, max, minLength }: {
  label: string; name: string; type?: string; value?: string | number; required?: boolean; placeholder?: string;
  onChange?: (value: string) => void; min?: string | number; max?: string | number; minLength?: number;
}) {
  return <div className="field"><label htmlFor={`field-${name}`}>{label}{required && " *"}</label><input id={`field-${name}`} name={name} type={type} {...(type !== "file" ? { value: value ?? "" } : {})} required={required} placeholder={placeholder} min={min} max={max} minLength={type === "password" ? minLength : undefined} onChange={onChange ? (event) => onChange(event.target.value) : undefined} /></div>;
}

function SelectField({ label, name, value, choices, required = false }: { label: string; name: string; value?: string; choices: string[]; required?: boolean }) {
  return <div className="field"><label htmlFor={`field-${name}`}>{label}{required && " *"}</label><select id={`field-${name}`} name={name} defaultValue={value || choices[0]} required={required}>{choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></div>;
}

function TextareaField({ label, name, value, required, placeholder }: { label: string; name: string; value?: string; required?: boolean; placeholder?: string }) {
  return <div className="field full"><label htmlFor={`field-${name}`}>{label}{required && " *"}</label><textarea id={`field-${name}`} name={name} defaultValue={value || ""} required={required} placeholder={placeholder} /></div>;
}

function EditorDialog({ type, item = {}, workspace, busy, onClose, onSubmit }: {
  type: RecordType; item?: Record<string, unknown>; workspace: Workspace; busy: boolean;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const titles: Record<RecordType, string> = {
    account: item.id ? "Edit social account" : "Add a social account",
    post: item.id ? "Edit planned post" : "Plan a post",
    project: item.id ? "Update project" : "Add a project",
    contact: item.id ? "Edit contact" : "Add a contact",
    profile: "Your strategy",
  };
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>((item.accountIds as string[]) || []);
  const full = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  const initialDate = String(item.publishAt || "");
  const today = new Date().toISOString().slice(0, 10);
  return <dialog className="editor-dialog" open onClick={full}><form onSubmit={onSubmit}>
    <div className="dialog-heading"><div><p className="eyebrow">{type === "profile" ? "PERSONALIZE YOUR WORKSPACE" : type.toUpperCase()}</p><h2>{titles[type]}</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>
    <div className="dialog-fields">
      {type === "profile" && <>
        <Field label="Your name" name="name" value={String(item.name || "")} placeholder="How should we address you?" />
        <Field label="Posting rhythm" name="cadence" value={String(item.cadence || "")} placeholder="e.g. 3 posts per week" />
        <Field label="Primary goal" name="objective" value={String(item.objective || "")} placeholder="e.g. Find freelance clients" required />
        <Field label="Who do you want to reach?" name="audience" value={String(item.audience || "")} placeholder="Describe your audience" />
        <TextareaField label="More context" name="context" value={String(item.context || "")} placeholder="Voice, offer, milestones, or anything else to keep in mind." />
      </>}
      {type === "account" && <>
        <SelectField label="Platform" name="platform" value={String(item.platform || "")} choices={PLATFORMS} required />
        <Field label="Display name" name="label" value={String(item.label || "")} placeholder="e.g. Studio LinkedIn" />
        <Field label="Handle or profile URL" name="handle" value={String(item.handle || "")} placeholder="@yourhandle or profile link" />
        <Field label="Account objective" name="goal" value={String(item.goal || "")} placeholder="e.g. Grow an engaged audience" />
        <Field label="Current audience" name="audienceSize" type="number" value={item.audienceSize as number || ""} min={0} />
        <Field label="Audience target" name="target" type="number" value={item.target as number || ""} min={0} />
      </>}
      {type === "post" && <>
        <Field label="Post title" name="title" value={String(item.title || "")} placeholder="A short internal title" />
        <TextareaField label="Draft copy or idea" name="body" value={String(item.body || "")} required placeholder="What do you want to share? Keep your audience and goal in mind." />
        <div className="field full"><label>Publish on</label>{workspace.accounts.length ? <div className="checkbox-group">{workspace.accounts.map((account) => <label className="check-chip" key={account.id}><input type="checkbox" name="accountIds" value={account.id} checked={selectedAccounts.includes(account.id)} onChange={(event) => setSelectedAccounts((current) => event.target.checked ? [...current, account.id] : current.filter((id) => id !== account.id))} />{account.platform}{account.handle ? ` · ${account.handle}` : ""}</label>)}</div> : <span className="field-hint">Add an account first to assign this post to a channel.</span>}</div>
        <Field label="Content objective" name="objective" value={String(item.objective || workspace.profile.objective)} placeholder="e.g. Build awareness, start conversations" />
        <SelectField label="Status" name="status" value={String(item.status || "idea")} choices={["idea", "scheduled", "published"]} />
        <Field label="Planned publish time" name="publishAt" type="datetime-local" value={toLocalDateTime(initialDate)} />
        <Field label="Reminder time" name="remindAt" type="datetime-local" value={toLocalDateTime(String(item.remindAt || ""))} />
      </>}
      {type === "project" && <>
        <Field label="Project name" name="name" value={String(item.name || "")} placeholder="e.g. Product launch" required />
        <Field label="Category" name="category" value={String(item.category || "")} placeholder="Campaign, launch, brand…" />
        <SelectField label="Status" name="status" value={String(item.status || "In progress")} choices={["In progress", "Planning", "On hold", "Complete"]} />
        <Field label="Progress" name="progress" type="number" value={Number(item.progress || 0)} min={0} max={100} />
        <Field label="Next milestone date" name="dueDate" type="date" value={String(item.dueDate || "")} />
        <Field label="Description" name="description" value={String(item.description || "")} placeholder="What are you working toward?" />
        <TextareaField label="Progress update" name="update" value={String(item.update || "")} placeholder="What changed? What can you share?" />
        <Field label="Attach files" name="attachments" type="file" />
        <span className="field-hint">Files are uploaded to your server and only available in your signed-in workspace.</span>
      </>}
      {type === "contact" && <>
        <Field label="Name" name="name" value={String(item.name || "")} placeholder="Person's name" required />
        <Field label="Role" name="role" value={String(item.role || "")} placeholder="e.g. Founder, designer" />
        <Field label="Company" name="company" value={String(item.company || "")} placeholder="Organization" />
        <Field label="Connection channel" name="channel" value={String(item.channel || "")} placeholder="LinkedIn, event, email…" />
        <Field label="Follow-up date" name="followUp" type="date" value={String(item.followUp || "")} min={today} />
        <TextareaField label="Conversation notes" name="note" value={String(item.note || "")} placeholder="Context, shared interests, or a helpful next step." />
      </>}
    </div>
    <div className="dialog-actions"><Button type="button" className="button-quiet" onClick={onClose}>Cancel</Button><Button className="button-primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button></div>
  </form></dialog>;
}

function PasswordDialog({ csrfToken, onClose, notify }: { csrfToken: string; onClose: () => void; notify: (message: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") || "");
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== data.get("confirmPassword")) {
      notify("New password and confirmation do not match.", true);
      return;
    }
    setBusy(true);
    try {
      await request("/api/password", csrfToken, { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      notify("Your password has been changed.");
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not change your password.", true);
    } finally {
      setBusy(false);
    }
  };
  return <dialog className="editor-dialog" open><form onSubmit={submit}><div className="dialog-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>Change password</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></div><div className="dialog-fields"><Field label="Current password" name="currentPassword" type="password" required /><Field label="New password" name="newPassword" type="password" required minLength={12} /><Field label="Confirm new password" name="confirmPassword" type="password" required minLength={12} /></div><div className="dialog-actions"><Button type="button" className="button-quiet" onClick={onClose}>Cancel</Button><Button className="button-primary" disabled={busy}>{busy ? "Saving…" : "Update password"}</Button></div></form></dialog>;
}
