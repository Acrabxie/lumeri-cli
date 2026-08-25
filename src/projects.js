// Project command parsing and filtering shared by the CLI UI and tests.
// The backend retains internal production containers for standalone Chats;
// only named, user-facing Projects belong in the terminal Project roster.

export function isUserFacingProject(project) {
  const id = String(project?.project_id || "").trim();
  const name = String(project?.name || "").trim();
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  if (!id || !name || name === id) return false;
  if (name === "DMG Project QA" && !project?.source_root && sessions.length === 0) return false;
  return true;
}

export function visibleProjects(payload) {
  const projects = Array.isArray(payload) ? payload : payload?.projects;
  return Array.isArray(projects) ? projects.filter(isUserFacingProject) : [];
}

export function parseProjectCommand(input) {
  const text = String(input || "").trim();
  if (!text || text === "list") return { action: "list" };
  if (text === "leave") return { action: "leave" };

  for (const action of ["use", "resume"]) {
    if (text === action) return { action, selector: "" };
    if (text.startsWith(action + " ")) {
      return { action, selector: text.slice(action.length + 1).trim() };
    }
  }

  if (text === "create" || text.startsWith("create ")) {
    let rest = text.slice("create".length).trim();
    let sourceRoot = "";
    const marker = " --folder ";
    const markerAt = rest.indexOf(marker);
    if (rest.startsWith("--folder ")) {
      sourceRoot = rest.slice("--folder ".length).trim();
      rest = "";
    } else if (markerAt >= 0) {
      sourceRoot = rest.slice(markerAt + marker.length).trim();
      rest = rest.slice(0, markerAt).trim();
    }
    return { action: "create", name: rest, sourceRoot };
  }

  return { action: "invalid" };
}

export function selectProject(projects, selector) {
  const query = String(selector || "").trim();
  if (!query) return null;
  if (/^\d+$/.test(query)) return projects[Number(query) - 1] || null;
  const folded = query.toLowerCase();
  return projects.find(
    (project) =>
      String(project.project_id || "") === query ||
      String(project.name || "").toLowerCase() === folded,
  ) || null;
}

export function selectProjectSession(project, selector) {
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  const query = String(selector || "").trim();
  if (!query) return null;
  if (/^\d+$/.test(query)) return sessions[Number(query) - 1] || null;
  return sessions.find((session) => String(session.session_id || "") === query) || null;
}
