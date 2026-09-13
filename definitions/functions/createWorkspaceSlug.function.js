function createWorkspaceSlug(workspace) {
  const sequence = schema.state.Demo.nextWorkspaceNumber;
  schema.state.Demo.nextWorkspaceNumber += 1;
  const name = workspace.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${name || "workspace"}-${sequence}`;
}
