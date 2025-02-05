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
function extractScript(text: string): string {
  const match = text.match(/script:\s*([\s\S]*)/);
  console.log(match);
  return match ? match[1] : "";
}

// `.ts` 用の仮ファイル
const tempFilePath = path.join(__dirname, "temp.ts");

// TypeScript 言語サービス
const tsHost: ts.LanguageServiceHost = {
  getScriptFileNames: () => [tempFilePath],
  getScriptVersion: () => "1",
  getScriptSnapshot: (fileName) =>
    fileName === tempFilePath
      ? ts.ScriptSnapshot.fromString(fs.readFileSync(tempFilePath, "utf8"))
      : undefined,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ESNext,
  }),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  readFile: (fileName) => fs.readFileSync(fileName, "utf8"),
  fileExists: (fileName) => fs.existsSync(fileName),
};

const tsService = ts.createLanguageService(tsHost);

// `.lun` の変更を監視
documents.onDidChangeContent((change) => {
  const text = change.document.getText();
  console.log(text);
  fs.writeFileSync(tempFilePath, extractScript(text));

  // TypeScript の診断
  const diagnostics: Diagnostic[] = [];
  tsService.getSyntacticDiagnostics(tempFilePath).forEach((tsDiag) => {
    if (tsDiag.file && tsDiag.start !== undefined) {
      const start = tsDiag.file.getLineAndCharacterOfPosition(tsDiag.start);
      const end = tsDiag.file.getLineAndCharacterOfPosition(
        tsDiag.start + tsDiag.length!,
      );

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: start.line, character: start.character },
          end: { line: end.line, character: end.character },
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
      const position = fs.readFileSync(tempFilePath, "utf8").length;
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

// LSP の接続を開始
documents.listen(connection);
connection.listen();
