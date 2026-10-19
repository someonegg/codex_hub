import type { SessionListResponse } from "../../shared/api-contract";
import type { SessionSummary } from "../../shared/domain";

interface ProjectGroup {
  id: string | null;
  directory: string | null;
  name: string;
  sessions: SessionSummary[];
  updatedAt: number;
}
export function catalogGroups(
  list: SessionListResponse | null,
  includeArchived: boolean,
): ProjectGroup[] {
  if (!list) return [];
  const groups = new Map<string | null, ProjectGroup>();
  const names = new Map<string, number>();
  for (const project of list.projects) {
    const name = project.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? project.directory;
    names.set(name, (names.get(name) ?? 0) + 1);
    groups.set(project.id, {
      id: project.id,
      directory: project.directory,
      name,
      sessions: [],
      updatedAt: -Infinity,
    });
  }
  groups.set(null, {
    id: null,
    directory: null,
    name: "Unknown project",
    sessions: [],
    updatedAt: -Infinity,
  });
  for (const session of list.sessions) {
    if (session.isChild || (!includeArchived && session.status === "archived")) continue;
    const group = groups.get(session.projectId) ?? groups.get(null)!;
    group.sessions.push(session);
  }
  for (const group of groups.values()) {
    const timedSessions = group.sessions.map((session) => {
      const time = session.updatedAt === null ? NaN : Date.parse(session.updatedAt);
      return { session, time: Number.isNaN(time) ? -Infinity : time };
    });
    timedSessions.sort(
      (a, b) => compareTime(a.time, b.time) || compareId(a.session.id, b.session.id),
    );
    group.sessions = timedSessions.map(({ session }) => session);
    group.updatedAt = timedSessions[0]?.time ?? -Infinity;
    if ((names.get(group.name) ?? 0) > 1) group.name += ` · ${group.directory}`;
  }
  return [...groups.values()]
    .filter((group) => group.sessions.length > 0)
    .sort((a, b) => compareTime(a.updatedAt, b.updatedAt) || compareId(a.id ?? "", b.id ?? ""));
}
function compareTime(a: number, b: number) {
  return a === b ? 0 : a > b ? -1 : 1;
}
function compareId(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A child may use another working directory; navigation belongs to its main ancestor. */
export function projectForSession(
  list: SessionListResponse | null,
  id: string | null,
): string | null | undefined {
  if (list === null || id === null) return undefined;
  const sessions = new Map(list.sessions.map((session) => [session.id, session]));
  let current = sessions.get(id);
  const visited = new Set<string>();
  while (current?.isChild && current.parentId !== null && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = sessions.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.projectId;
}
