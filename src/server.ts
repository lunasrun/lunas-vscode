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

async function init() {
  // LSP の接続を作成
  const connection = createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments(
    TextDocument,
  );

  const INDENT_SIZE = 2;
  let scriptVersion = 0; // スクリプトのバージョン管理用

  let totalAdditionalPartChars = 0;
  let totalAdditionalPartLines = 0;
  let extraTypings: string[] = [];

  connection.onInitialize((params: InitializeParams) => {
    const workspaceFolders = params.workspaceFolders || [];
    const workspaceRoot =
      workspaceFolders.length > 0
        ? new URL(workspaceFolders[0].uri).pathname
        : process.cwd();

    console.log("workspaceRoot", workspaceRoot);
    // workspaceSrcRoot
    const workspaceSrcRoot = path.join(workspaceRoot, "src");
    const files = fs.readdirSync(workspaceSrcRoot);
    const dtsFiles = files.filter((file) => file.endsWith(".d.ts"));
    extraTypings = dtsFiles.map((file) => path.join(workspaceSrcRoot, file));

    console.log("extraTypings", extraTypings);

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { resolveProvider: true },
        hoverProvider: true,
        definitionProvider: true,
      },
      workspace: {
        workspaceFolders: {
          supported: true,
        },
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

  // `@input` を解析
  function extractInputs(text: string): Record<string, string> {
    const inputRegex = /@input\s+([\w\d_]+)\s*:\s*([\w\d_]+)/g;
    const inputs: Record<string, string> = {};
    let match;

    while ((match = inputRegex.exec(text)) !== null) {
      const [, name, type] = match;
      inputs[name] = type;
    }

    return inputs;
  }

  function findAndReadTSConfig(startPath: string): ts.ParsedCommandLine {
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
    // fallback
    return ts.parseJsonConfigFileContent({}, ts.sys, process.cwd());
  }


  // TypeScript 言語サービス
  const tsHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => [
      ...extraTypings,
      ...Array.from(scriptContents.keys()),
    ],

    getScriptVersion: (fileName) => {
      return (scriptVersions.get(fileName) || 0).toString();
    },

    getScriptSnapshot: (fileName) => {
      const content = scriptContents.get(fileName);
      if (content !== undefined) {
        return ts.ScriptSnapshot.fromString(content);
      }
      if (fs.existsSync(fileName)) {
        return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
      }
      return undefined;
    },

    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => {
      const firstFile = Array.from(scriptContents.keys())[0];
      if (!firstFile) return ts.getDefaultCompilerOptions();

      const dir = path.dirname(firstFile);
      if (!tsConfigCache.has(dir)) {
        tsConfigCache.set(dir, findAndReadTSConfig(firstFile));
      }
      return tsConfigCache.get(dir)!.options;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    readFile: (fileName) => {
      return fs.existsSync(fileName)
        ? fs.readFileSync(fileName, "utf-8")
        : undefined;
    },
    fileExists: (fileName) => {
      return scriptContents.has(fileName) || fs.existsSync(fileName);
    },
  };

  const tsService = ts.createLanguageService(tsHost);

  // `.lun` の変更を監視
  documents.onDidChangeContent((change) => {
    const text = change.document.getText();
    const uri = change.document.uri;
    const virtualPath = getVirtualFilePath(uri);

    const { script, startLine } = extractScript(text);
    const inputs = extractInputs(text);

    const inputDeclarations =
      Object.entries(inputs)
        .map(([name, type]) => `declare let ${name}: ${type};`)
        .join("\n") + "\n";

    totalAdditionalPartChars = inputDeclarations.length;
    totalAdditionalPartLines = inputDeclarations.split("\n").length - 1;

    const updatedScript = `${inputDeclarations}${script}`;

    // 更新があるときだけ保存・バージョンアップ
    if (scriptContents.get(virtualPath) !== updatedScript) {
      scriptContents.set(virtualPath, updatedScript);
      scriptVersions.set(
        virtualPath,
        (scriptVersions.get(virtualPath) || 0) + 1,
      );
    }

    const diagnostics: Diagnostic[] = [];
    const syntaxDiagnostics = tsService.getSyntacticDiagnostics(virtualPath);
    const semanticDiagnostics = tsService.getSemanticDiagnostics(virtualPath);

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
              line: start.line + startLine - totalAdditionalPartLines,
              character: start.character + INDENT_SIZE,
            },
            end: {
              line: end.line + startLine - totalAdditionalPartLines,
              character: end.character + INDENT_SIZE,
            },
          },
          message: ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n"),
          source: "Lunas TS",
        });
      }
    });

    connection.sendDiagnostics({ uri, diagnostics });
  });

  const scriptContents = new Map<string, string>(); // 仮想ファイル名 -> script内容
  const scriptVersions = new Map<string, number>(); // 仮想ファイル名 -> バージョン
  const tsConfigCache = new Map<string, ts.ParsedCommandLine>();

  function getVirtualFilePath(documentUri: string): string {
    const realPath = new URL(documentUri).pathname; // LSP URI → ファイルパス
    const parsedPath = path.parse(realPath);
    const virtualFileName = `.${parsedPath.name}.virtual.ts`;
    return path.join(parsedPath.dir, virtualFileName);
  }

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
      totalAdditionalPartChars,
    );
    if (!localPosition) return null;

    const localOffset = localPosition.localPosition.offset;

    const virtualPath = getVirtualFilePath(params.textDocument.uri);
    const quickInfo = tsService.getQuickInfoAtPosition(
      virtualPath,
      localOffset,
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
      totalAdditionalPartChars,
    );
    if (!localPosition) return null;

    const localOffset = localPosition.localPosition.offset;
    const virtualPath = getVirtualFilePath(params.textDocument.uri);
    const definitions = tsService.getDefinitionAtPosition(
      virtualPath,
      localOffset,
    );
    if (!definitions) return null;

    const results: Location[] = [];

    definitions.forEach((def) => {
      if (def.fileName === virtualPath) {
        // `.lun` 内の定義の場合、元のファイル上の位置に変換
        const sourceFile = tsService.getProgram()?.getSourceFile(virtualPath);
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
                line: startPos.line + startLine - totalAdditionalPartLines,
                character: startPos.character + INDENT_SIZE,
              },
              end: {
                line: endPos.line + startLine - totalAdditionalPartLines,
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

  connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

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
      totalAdditionalPartChars,
    );
    if (!localPosition) return [];

    const localOffset = localPosition.localPosition.offset;
    const virtualPath = getVirtualFilePath(params.textDocument.uri);
    const completions = tsService.getCompletionsAtPosition(
      virtualPath,
      localOffset,
      {},
    );
    if (!completions) return [];

    const items: CompletionItem[] = completions.entries.map((entry) => ({
      label: entry.name,
      kind: CompletionItemKind.Text,
    }));

    return items;
  });

  connection.onCompletionResolve((item) => {
    if (item.data) {
      const { uri, offset, entryName } = item.data as {
        uri: string;
        offset: number;
        entryName: string;
      };
      const virtualPath = getVirtualFilePath(uri);
      const details = tsService.getCompletionEntryDetails(
        virtualPath,
        offset,
        entryName,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      if (details) {
        item.detail = ts.displayPartsToString(details.displayParts || []);
        item.documentation = ts.displayPartsToString(
          details.documentation || [],
        );
      }
    }
    return item;
  });

  // LSP の接続を開始
  documents.listen(connection);
  connection.listen();
}

init();
