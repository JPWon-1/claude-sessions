export function folderToProjectPath(folder: string): string {
  return folder.replace(/-/g, "/");
}

export function projectPathToFolder(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}
