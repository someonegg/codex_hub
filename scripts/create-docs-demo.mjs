import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const destination = process.argv[2];
if (!destination || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/create-docs-demo.mjs <new-directory>");
}
const home = resolve(destination);
// Exclusive creation prevents overwriting an existing Codex home.
await mkdir(home);
await mkdir(join(home, "sessions"));
await mkdir(join(home, "archived_sessions"));

const sessions = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Design the project dashboard",
    project: "atlas-dashboard",
    hour: 14,
    messages: [
      ["user", "Design a clear project dashboard with a concise overview and recent activity."],
      [
        "assistant",
        'Here is a focused starting point for the dashboard.\n\n### A place for every project\n\nKeep the overview simple: show what needs attention, then let people explore the details.\n\n| Area | Purpose |\n| --- | --- |\n| Overview | Project health at a glance |\n| Activity | Recent changes and decisions |\n| Tasks | The next useful action |\n\n```ts\nconst dashboard = {\n  view: "overview",\n  sort: "recent-activity",\n};\n```\n\nStart with a responsive layout and keep project navigation visible on wider screens.',
      ],
      ["user", "Keep the mobile view focused on one project at a time."],
      [
        "assistant",
        "On mobile, navigation and the conversation use separate views. Returning to projects preserves your place.",
      ],
    ],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Add keyboard navigation",
    project: "atlas-dashboard",
    hour: 12,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Review the release checklist",
    project: "harbor-api",
    hour: 11,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    title: "Document the API endpoints",
    project: "harbor-api",
    hour: 10,
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    title: "Outline the getting started guide",
    project: "field-notes",
    hour: 9,
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    title: "Explore the first layout",
    project: "atlas-dashboard",
    hour: 8,
    archived: true,
  },
];
for (const session of sessions) {
  const timestamp = `2026-10-16T${String(session.hour).padStart(2, "0")}:00:00.000Z`;
  const records = [
    {
      timestamp,
      type: "session_meta",
      payload: { id: session.id, cwd: `/projects/${session.project}`, timestamp },
    },
  ];
  const messages = session.messages ?? [
    ["user", session.title + "."],
    ["assistant", "I will keep the scope focused and document the result."],
  ];
  messages.forEach(([role, message], index) => {
    records.push({
      timestamp: timestamp.replace(":00.000Z", `:${String(index + 1).padStart(2, "0")}.000Z`),
      type: "event_msg",
      payload: { type: role === "user" ? "user_message" : "agent_message", message },
    });
  });
  await writeFile(
    join(home, session.archived ? "archived_sessions" : "sessions", `rollout-${session.id}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}
await writeFile(
  join(home, "session_index.jsonl"),
  sessions.map(({ id, title }) => JSON.stringify({ id, thread_name: title })).join("\n") + "\n",
);
console.log(`Documentation demo created at ${home}`);
