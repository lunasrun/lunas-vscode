import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import * as path from "path";

// LSP の接続を作成
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const INDENT_SIZE = 2;
let scriptVersion = 0; // スクリプトのバージョン管理用

connection.onInitialize((params: InitializeParams) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: true },
      hoverProvider: true, // ホバー機能を有効化
    },
  };
});

// `.lun` の `script:` を抽出
function extractScript(text: string): { script: string; startLine: number } {
  const scriptMatch = text.match(/script:\s*\n([\s\S]*?)(?:\n\s*style:|$)/);
  if (!scriptMatch) {
    return { script: "", startLine: 0 };
  }

  const scriptStart = text.indexOf("script:");
  const startLine = text.substring(0, scriptStart).split("\n").length;

  let scriptLines = scriptMatch[1].split("\n");
  scriptLines = scriptLines.map((line) =>
    line.startsWith("  ") ? line.slice(2) : line,
  );

  return { script: scriptLines.join("\n"), startLine };
}

// `.ts` 用の仮ファイル
const tempFilePath = path.join(__dirname, "temp.ts");

let tempScriptContent = ""; // 最新のスクリプトを保存

// TypeScript 言語サービス
const tsHost: ts.LanguageServiceHost = {
  getScriptFileNames: () => [tempFilePath],
  getScriptVersion: () => scriptVersion.toString(), // バージョンを変更
  getScriptSnapshot: (fileName) =>
    fileName === tempFilePath
      ? ts.ScriptSnapshot.fromString(tempScriptContent) // 最新の内容を返す
      : undefined,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ESNext,
    strict: true,
  }),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  readFile: (fileName) =>
    fileName === tempFilePath ? tempScriptContent : undefined,
  fileExists: (fileName) => fileName === tempFilePath,
};

const tsService = ts.createLanguageService(tsHost);

// `.lun` の変更を監視
documents.onDidChangeContent((change) => {
  const text = change.document.getText();
  const { script, startLine } = extractScript(text);

  if (tempScriptContent !== script) {
    tempScriptContent = script;
    scriptVersion++; // バージョンを更新
  }

  console.log("Updated Script Content:");
  console.log(tempScriptContent);

  const diagnostics: Diagnostic[] = [];
  const syntaxDiagnostics = tsService.getSyntacticDiagnostics(tempFilePath);
  const semanticDiagnostics = tsService.getSemanticDiagnostics(tempFilePath);

  const allDiagnostics = [...syntaxDiagnostics, ...semanticDiagnostics];
  allDiagnostics.forEach((tsDiag) => {
    if (tsDiag.file && tsDiag.start !== undefined) {
      const start = tsDiag.file.getLineAndCharacterOfPosition(tsDiag.start);
      const end = tsDiag.file.getLineAndCharacterOfPosition(
        tsDiag.start + (tsDiag.length || 0),
      );

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: {
            line: start.line + startLine,
            character: start.character + INDENT_SIZE,
          },
          end: {
            line: end.line + startLine,
            character: end.character + INDENT_SIZE,
          },
        },
        message: ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n"),
        source: "Lunas TS",
      });
    }
  });

  console.log("Debug: Diagnostics length: ", diagnostics.length);

  connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

// **ホバーで型情報を提供**
connection.onHover((params): Hover | null => {
  console.log("Debug: Hover Requested");
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const { script, startLine } = extractScript(text);

  const position = doc.offsetAt(params.position);
  const scriptOffset = position - doc.getText().indexOf("script:") - 8;

  if (scriptOffset < 0 || scriptOffset >= script.length) return null;

  const quickInfo = tsService.getQuickInfoAtPosition(
    tempFilePath,
    scriptOffset,
  );
  if (!quickInfo) return null;

  const displayParts =
    quickInfo.displayParts?.map((part) => part.text).join("") ?? "";
  const documentation =
    quickInfo.documentation?.map((part) => part.text).join("\n") ?? "";

  return {
    contents: {
      kind: "markdown",
      value: `**${displayParts}**\n\n${documentation}`,
    },
  };
});

// LSP の接続を開始
documents.listen(connection);
connection.listen();
