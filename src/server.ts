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
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

// LSP の接続を作成
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: true },
    },
  };
});
// `.lun` の `script:` を抽出
function extractScript(text: string): { script: string; startLine: number } {
  const scriptMatch = text.match(/script:\s*\n([\s\S]*?)(?:\n\s*style:|$)/);
  if (!scriptMatch) {
    return { script: "", startLine: 0 };
  }

  // `script:` の開始位置を取得
  const scriptStart = text.indexOf("script:");
  const startLine = text.substring(0, scriptStart).split("\n").length;

  // スクリプトの内容を取得
  let scriptLines = scriptMatch[1].split("\n");

  // **スペース 2 個のインデントを削除**
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
  getScriptVersion: () => "1",
  getScriptSnapshot: (fileName) =>
    fileName === tempFilePath
      ? ts.ScriptSnapshot.fromString(tempScriptContent)
      : undefined,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ESNext,
    strict: true, // 型エラーを厳しくチェック
  }),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  readFile: (fileName) => {
    return fileName === tempFilePath ? tempScriptContent : undefined;
  },
  fileExists: (fileName) => fileName === tempFilePath,
};

const tsService = ts.createLanguageService(tsHost);

// `.lun` の変更を監視
documents.onDidChangeContent((change) => {
  const text = change.document.getText();
  const { script, startLine } = extractScript(text);

  tempScriptContent = script; // スクリプトをメモリに保存

  // console.log("Extracted Script:");
  // console.log(script);

  // TypeScript の診断
  const diagnostics: Diagnostic[] = [];

  // **構文エラー (Syntax Errors) を取得**
  const syntaxDiagnostics = tsService.getSyntacticDiagnostics(tempFilePath);

  // **型エラー (Type Errors) を取得**
  const semanticDiagnostics = tsService.getSemanticDiagnostics(tempFilePath);

  const allDiagnostics = [...syntaxDiagnostics, ...semanticDiagnostics];

  allDiagnostics.forEach((tsDiag) => {
    if (tsDiag.file && tsDiag.start !== undefined) {
      const start = tsDiag.file.getLineAndCharacterOfPosition(tsDiag.start);
      const end = tsDiag.file.getLineAndCharacterOfPosition(
        tsDiag.start + (tsDiag.length || 0),
      );

      // エラー行を補正する際、`startLine` を加算して調整
      const adjustedStartLine = start.line + startLine;
      const adjustedEndLine = end.line + startLine;

      // console.log(
      //   `Mapped Error: ${adjustedStartLine}, ${start.character} -> ${adjustedEndLine}, ${end.character}`,
      // );

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: adjustedStartLine, character: start.character + 2 },
          end: { line: adjustedEndLine, character: end.character + 2 },
        },
        message: ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n"),
        source: "Lunas TS",
      });
    }
  });

  connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

// TypeScript の補完を提供
connection.onCompletion(() => {
  const completions: CompletionItem[] = [];
  const program = tsService.getProgram();
  if (program) {
    const sourceFile = program.getSourceFile(tempFilePath);
    if (sourceFile) {
      const position = tempScriptContent.length;
      const completionsInfo = tsService.getCompletionsAtPosition(
        tempFilePath,
        position,
        {},
      );
      if (completionsInfo) {
        completionsInfo.entries.forEach((entry) => {
          completions.push({
            label: entry.name,
            kind: CompletionItemKind.Function,
          });
        });
      }
    }
  }
  return completions;
});

// **ホバーで型情報を提供**
connection.onHover((params) => {
  // console.log("hover Xparams", params);
  const doc = documents.get(params.textDocument.uri);
  // console.log("Xdoc", doc);
  if (!doc) return null;

  const text = doc.getText();
  const { script, startLine } = extractScript(text);

  const position = doc.offsetAt(params.position); // ホバー位置のオフセット
  const scriptOffset = position - doc.getText().indexOf("script:") - 8; // スクリプト内のオフセット調整

  if (scriptOffset < 0 || scriptOffset >= script.length) return null; // 範囲外なら無視

  const quickInfo = tsService.getQuickInfoAtPosition(
    tempFilePath,
    scriptOffset,
  );
  // console.log("XquickInfo", scriptOffset);
  // console.log(quickInfo);
  if (!quickInfo) return null;

  // TypeScript の型情報を整形
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
