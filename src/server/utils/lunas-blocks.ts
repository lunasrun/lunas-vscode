import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

export function extractScript(text: string): {
  script: string;
  startLine: number;
  endLine: number;
} {
  const scriptMatch = text.match(/script:\s*\n([\s\S]*?)(?:\n\s*style:|$)/);
  if (!scriptMatch) {
    return { script: "", startLine: 0, endLine: 0 };
  }
  const scriptStart = text.indexOf("script:");
  const startLine = text.substring(0, scriptStart).split("\n").length;
  const scriptLines = scriptMatch[1]
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line));
  return {
    script: scriptLines.join("\n"),
    startLine,
    endLine: startLine + scriptLines.length - 1,
  };
}

export function extractInputs(text: string): Record<string, string> {
  const inputRegex = /@input\s+([\w\d_]+)\s*:\s*([\w\d_]+)/g;
  const inputs: Record<string, string> = {};
  let match;
  while ((match = inputRegex.exec(text)) !== null) {
    const [, name, type] = match;
    inputs[name] = type;
  }
  return inputs;
}

export function extractHTML(text: string): {
  html: string;
  startLine: number;
  endLine: number;
  indent: number;
} {
  const htmlRegex = /html:\s*\n([\s\S]*?)(?:\n\s*(?:script:|style:)|$)/;
  htmlRegex.lastIndex = 0;
  const match = htmlRegex.exec(text);
  if (!match) return { html: "", startLine: 0, endLine: 0, indent: 0 };
  const full = match[1];
  const htmlKeywordIndex = match.index ?? text.indexOf("html:");
  const startLine = text.substring(0, htmlKeywordIndex).split("\n").length;
  const rawLines = full.split("\n");
  const indentCounts = rawLines
    .filter((l) => l.trim() !== "")
    .map((l) => l.match(/^\s*/)![0].length);
  const minIndent = indentCounts.length > 0 ? Math.min(...indentCounts) : 0;
  const lines = rawLines.map((line) => {
    const content = line.startsWith(" ".repeat(minIndent))
      ? line.slice(minIndent)
      : line;
    const sanitized = content.replace(/<\/(\/\w+)>?/g, "</$1>");
    return sanitized;
  });
  return {
    html: lines.join("\n"),
    startLine,
    endLine: startLine + lines.length - 1,
    indent: minIndent,
  };
}

export function extractStyle(text: string): {
  css: string;
  startLine: number;
  endLine: number;
  indent: number;
} {
  const match = text.match(/style:\s*\n([\s\S]*?)(?:\n\s*(script:|html:)|$)/);
  if (!match) return { css: "", startLine: 0, endLine: 0, indent: 0 };
  const full = match[1];
  const rawLines = full.split("\n");
  const indentCounts = rawLines
    .filter((l) => l.trim() !== "")
    .map((l) => l.match(/^\s*/)![0].length);
  const minIndent = indentCounts.length > 0 ? Math.min(...indentCounts) : 0;
  const startLine = text
    .substring(0, text.indexOf("style:"))
    .split("\n").length;
  const lines = rawLines.map((line) =>
    line.startsWith(" ".repeat(minIndent)) ? line.slice(minIndent) : line
  );
  return {
    css: lines.join("\n"),
    startLine,
    endLine: startLine + lines.length - 1,
    indent: minIndent,
  };
}

export function findAndReadTSConfig(startPath: string): ts.ParsedCommandLine {
  let dir = path.dirname(startPath);
  while (true) {
    const configPath = path.join(dir, "tsconfig.json");
    if (fs.existsSync(configPath)) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      if (configFile.error) throw new Error("Failed to read tsconfig.json");
      return ts.parseJsonConfigFileContent(configFile.config, ts.sys, dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ts.parseJsonConfigFileContent({}, ts.sys, process.cwd());
}

export function getVirtualFilePath(documentUri: string): string {
  const realPath = new URL(documentUri).pathname;
  const parsedPath = path.parse(realPath);
  const virtualFileName = `.${parsedPath.name}.virtual.ts`;
  return path.join(parsedPath.dir, virtualFileName);
}

export function setActiveFileFromUri(
  uri: string,
  setActive: (v: string) => void,
) {
  setActive(getVirtualFilePath(uri));
}
