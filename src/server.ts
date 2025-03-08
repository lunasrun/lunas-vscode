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
  Location,
} from "vscode-languageserver/node";
import * as fs from "fs";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  getLocationInBlock,
  textLocationVisualizer,
} from "./utils/text-location";

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
      definitionProvider: true, // 定義ジャンプ機能を有効化
    },
  };
});

// `.lun` の `script:` を抽出
function extractScript(text: string): {
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

  let scriptLines = scriptMatch[1].split("\n");
  scriptLines = scriptLines.map((line) =>
    line.startsWith("  ") ? line.slice(2) : line,
  );

  return {
    script: scriptLines.join("\n"),
    startLine,
    endLine: startLine + scriptLines.length - 1,
  };
}

// `.ts` 用の仮ファイル
const tempFilePath = path.join(__dirname, "temp.ts");
let tempScriptContent = ""; // 最新のスクリプトを保存

// TypeScript 言語サービス
const tsHost: ts.LanguageServiceHost = {
  getScriptFileNames: () => [tempFilePath],
  getScriptVersion: () => scriptVersion.toString(), // バージョンを変更
  getScriptSnapshot: (fileName) => {
    if (fileName === tempFilePath) {
      return ts.ScriptSnapshot.fromString(tempScriptContent);
    }
    return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName).toString());
  },
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => {
    return ts.getDefaultCompilerOptions();
  },
  getDefaultLibFileName: (options) => {
    return ts.getDefaultLibFilePath(options);
  },
  readFile: (fileName) => {
    if (fileName === tempFilePath) {
      return tempScriptContent;
    }
    return ts.sys.readFile(fileName, "utf-8");
  },
  fileExists: (fileName) => {
    if (fileName === tempFilePath) {
      return true;
    }
    return ts.sys.fileExists(fileName);
  },
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

  connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

// **ホバーで型情報を提供**
connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const { script, startLine, endLine } = extractScript(text);

  const localPosition = getLocationInBlock(
    text,
    startLine,
    endLine,
    INDENT_SIZE,
    {
      type: "line-column",
      line: params.position.line,
      column: params.position.character,
    },
  );
  if (!localPosition) return null;

  const localOffset = localPosition.localPosition.offset;

  const quickInfo = tsService.getQuickInfoAtPosition(tempFilePath, localOffset);
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

// **定義ジャンプをサポート**
connection.onDefinition((params): Location[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const { script, startLine, endLine } = extractScript(text);

  const localPosition = getLocationInBlock(
    text,
    startLine,
    endLine,
    INDENT_SIZE,
    {
      type: "line-column",
      line: params.position.line,
      column: params.position.character,
    },
  );
  if (!localPosition) return null;

  const localOffset = localPosition.localPosition.offset;
  const definitions = tsService.getDefinitionAtPosition(
    tempFilePath,
    localOffset,
  );
  if (!definitions) return null;

  const results: Location[] = [];

  definitions.forEach((def) => {
    if (def.fileName === tempFilePath) {
      // `.lun` 内の定義の場合、元のファイル上の位置に変換
      const sourceFile = tsService.getProgram()?.getSourceFile(tempFilePath);
      if (sourceFile) {
        const startPos = sourceFile.getLineAndCharacterOfPosition(
          def.textSpan.start,
        );
        const endPos = sourceFile.getLineAndCharacterOfPosition(
          def.textSpan.start + def.textSpan.length,
        );
        results.push({
          uri: params.textDocument.uri,
          range: {
            start: {
              line: startPos.line + startLine,
              character: startPos.character + INDENT_SIZE,
            },
            end: {
              line: endPos.line + startLine,
              character: endPos.character + INDENT_SIZE,
            },
          },
        });
      }
    } else {
      // 他ファイルの場合、URI に変換してそのまま返す
      const defUri = pathToFileURL(def.fileName).toString();
      const sourceFile = tsService.getProgram()?.getSourceFile(def.fileName);
      if (sourceFile) {
        const startPos = sourceFile.getLineAndCharacterOfPosition(
          def.textSpan.start,
        );
        const endPos = sourceFile.getLineAndCharacterOfPosition(
          def.textSpan.start + def.textSpan.length,
        );
        results.push({
          uri: defUri,
          range: {
            start: {
              line: startPos.line,
              character: startPos.character,
            },
            end: {
              line: endPos.line,
              character: endPos.character,
            },
          },
        });
      }
    }
  });

  return results;
});

// LSP の接続を開始
documents.listen(connection);
connection.listen();
