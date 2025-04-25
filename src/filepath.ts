import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Find the project root by searching upwards from start until stopAt.
 * Returns stopAt if no markers are found.
 *
 * @param start - initial path (file or directory)
 * @param stopAt - boundary path at which to stop searching
 */
export function findProjectRootWithBounds(
  start: string,
  stopAt: string,
): string {
  let currentDir = start;
  if (fs.statSync(currentDir).isFile()) {
    currentDir = path.dirname(currentDir);
  }

  while (true) {
    if (
      fs.existsSync(path.join(currentDir, "package.json")) ||
      fs.existsSync(path.join(currentDir, "node_modules"))
    ) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (currentDir === parentDir || currentDir === stopAt) {
      return stopAt;
    }
    currentDir = parentDir;
  }
}

/**
 * Get the workspace root path (or file system root if no workspace is open).
 *
 * @returns path to workspace root
 */
function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  // Fallback to file system root if no workspace
  return path.parse(process.cwd()).root;
}

/**
 * Find the project root for the currently active file in the editor.
 * Uses the file's directory as start, and workspace root as stopAt.
 *
 * @returns project root path
 */
export function findProjectRoot(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    // No active editor, fall back to workspace root directly
    return getWorkspaceRoot();
  }
  const filePath = editor.document.uri.fsPath;
  const startDir = fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);

  const stopAt = getWorkspaceRoot();
  return findProjectRootWithBounds(startDir, stopAt);
}
