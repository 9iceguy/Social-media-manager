export type Platform =
  | "Instagram"
  | "Facebook"
  | "LinkedIn"
  | "X"
  | "GitHub"
  | "TikTok"
  | "YouTube"
  | "Other";

export type Account = {
  id: string;
  platform: Platform;
  label: string;
  handle: string;
  goal: string;
  audienceSize: number | "";
  target: number | "";
  connected: boolean;
  connectedName?: string;
};

export type Post = {
  id: string;
  title: string;
  body: string;
  objective: string;
  status: "idea" | "scheduled" | "published" | "failed";
  publishAt: string;
  remindAt: string;
  accountIds: string[];
  createdAt: string;
  result?: string;
};

export type Project = {
  id: string;
  name: string;
  category: string;
  status: "In progress" | "Planning" | "On hold" | "Complete";
  progress: number;
  dueDate: string;
  description: string;
  update: string;
  attachments: { id: string; name: string; size: number }[];
};

export type Contact = {
  id: string;
  name: string;
  role: string;
  company: string;
  channel: string;
  followUp: string;
  note: string;
};

export type Workspace = {
  profile: {
    name: string;
    objective: string;
    audience: string;
    cadence: string;
    context: string;
  };
  accounts: Account[];
  posts: Post[];
  projects: Project[];
  contacts: Contact[];
  notifications: { id: string; message: string; createdAt: string }[];
  revision: number;
};

export const PLATFORMS: Platform[] = [
  "Instagram",
  "Facebook",
  "LinkedIn",
  "X",
  "GitHub",
  "TikTok",
  "YouTube",
  "Other",
];

export function emptyWorkspace(): Workspace {
  return {
    profile: { name: "", objective: "", audience: "", cadence: "", context: "" },
    accounts: [],
    posts: [],
    projects: [],
    contacts: [],
    notifications: [],
    revision: 0,
  };
}
