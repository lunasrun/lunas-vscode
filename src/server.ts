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
  // LSP の接続作成
  const connection = createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments(
    TextDocument,
  );

  const INDENT_SIZE = 2;
  let totalAdditionalPartChars = 0;
  let totalAdditionalPartLines = 0;
  let extraTypings: string[] = [];

  connection.onInitialize((params: InitializeParams) => {
    const workspaceFolders = params.workspaceFolders || [];
    const workspaceRoot =
      workspaceFolders.length > 0
        ? new URL(workspaceFolders[0].uri).pathname
        : process.cwd();

    // TODO: node_modulesを現在ファイルからworkspaceのrootまで順番に探すことで、
    // monorepoの場合にも対応できるようにする

    // const workspaceSrcRoot = path.join(workspaceRoot, "src");
    // ${workspace}/node_modules/lunas/dist/types/global.d.ts
    const workspaceSrcRoot = path.join(
      workspaceRoot,
      "node_modules",
      "lunas",
      "dist",
      "types",
    );
    const files = fs.readdirSync(workspaceSrcRoot);
    const dtsFiles = files.filter((file) => file.endsWith(".d.ts"));
    extraTypings = dtsFiles.map((file) => path.join(workspaceSrcRoot, file));

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

  // スクリプトブロック抽出（ブロックがなければ空文字列を返す）
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
    // startLine は "script:" 行までの行数
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

  // @input の解析
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
    return ts.parseJsonConfigFileContent({}, ts.sys, process.cwd());
  }

  // 仮想ファイルの内容とバージョンを管理
  const scriptContents = new Map<string, string>();
  const scriptVersions = new Map<string, number>();
  const tsConfigCache = new Map<string, ts.ParsedCommandLine>();

  // 現在リクエスト対象のファイルの仮想パスを保持
  let activeVirtualFile: string | null = null;

  function getVirtualFilePath(documentUri: string): string {
    const realPath = new URL(documentUri).pathname;
    const parsedPath = path.parse(realPath);
    const virtualFileName = `.${parsedPath.name}.virtual.ts`;
    return path.join(parsedPath.dir, virtualFileName);
  }

  // リクエスト前に対象ファイルを activeVirtualFile に設定するヘルパー
  function setActiveFileFromUri(uri: string) {
    activeVirtualFile = getVirtualFilePath(uri);
  }

  // TypeScript 言語サービスホスト（対象は activeVirtualFile のみ）
  const tsHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => {
      return activeVirtualFile
        ? [...extraTypings, activeVirtualFile]
        : [...extraTypings];
    },
    getScriptVersion: (fileName) =>
      (scriptVersions.get(fileName) || 0).toString(),
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
      if (!activeVirtualFile) return ts.getDefaultCompilerOptions();
      const dir = path.dirname(activeVirtualFile);
      if (!tsConfigCache.has(dir)) {
        tsConfigCache.set(dir, findAndReadTSConfig(activeVirtualFile));
      }
      return tsConfigCache.get(dir)!.options;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    readFile: (fileName) =>
      fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : undefined,
    fileExists: (fileName) =>
      scriptContents.has(fileName) || fs.existsSync(fileName),
  };

  const tsService = ts.createLanguageService(tsHost);

  // ドキュメント変更時に対象ファイルとして登録し、内容を更新
  documents.onDidChangeContent((change) => {
    const text = change.document.getText();
    const uri = change.document.uri;
    const virtualPath = getVirtualFilePath(uri);
    // リクエスト対象のファイルを更新
    activeVirtualFile = virtualPath;

    const { script, startLine } = extractScript(text);
    const inputs = extractInputs(text);
    const inputDeclarations =
      Object.entries(inputs)
        .map(([name, type]) => `declare let ${name}: ${type};`)
        .join("\n") + "\n";

    totalAdditionalPartChars = inputDeclarations.length;
    totalAdditionalPartLines = inputDeclarations.split("\n").length - 1;
    const updatedScript = `${inputDeclarations}${script}`;

    if (scriptContents.get(virtualPath) !== updatedScript) {
      scriptContents.set(virtualPath, updatedScript);
      scriptVersions.set(
        virtualPath,
        (scriptVersions.get(virtualPath) || 0) + 1,
      );
    }

    // scriptBlockStart を "script:" 行の次とする
    const scriptBlockStart = startLine + 1;

    const diagnostics: Diagnostic[] = [];
    const syntaxDiagnostics = tsService.getSyntacticDiagnostics(virtualPath);
    const semanticDiagnostics = tsService.getSemanticDiagnostics(virtualPath);

    // 仮想ファイルの位置から元ファイルの位置へ変換（各行番号から1行分上に調整）
    [...syntaxDiagnostics, ...semanticDiagnostics].forEach((tsDiag) => {
      if (tsDiag.file && tsDiag.start !== undefined) {
        const diagStart = tsDiag.file.getLineAndCharacterOfPosition(
          tsDiag.start,
        );
        const diagEnd = tsDiag.file.getLineAndCharacterOfPosition(
          tsDiag.start + (tsDiag.length || 0),
        );
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: {
            start: {
              line:
                diagStart.line -
                totalAdditionalPartLines +
                scriptBlockStart -
                1,
              character: diagStart.character + INDENT_SIZE,
            },
            end: {
              line:
                diagEnd.line - totalAdditionalPartLines + scriptBlockStart - 1,
              character: diagEnd.character + INDENT_SIZE,
            },
          },
          message: ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n"),
          source: "Lunas TS",
        });
      }
    });
    connection.sendDiagnostics({ uri, diagnostics });
  });

  // ドキュメントクローズ時にキャッシュから削除
  documents.onDidClose((change) => {
    const virtualPath = getVirtualFilePath(change.document.uri);
    scriptContents.delete(virtualPath);
    scriptVersions.delete(virtualPath);
  });

  // ホバー処理
  connection.onHover((params): Hover | null => {
    setActiveFileFromUri(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const text = doc.getText();
    const { script, startLine } = extractScript(text);
    if (!script) return null;
    const scriptBlockStart = startLine + 1;
    const localPosition = getLocationInBlock(
      text,
      startLine,
      startLine + script.split("\n").length,
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

  // 定義ジャンプ処理
  connection.onDefinition((params): Location[] | null => {
    setActiveFileFromUri(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const text = doc.getText();
    const { script, startLine } = extractScript(text);
    if (!script) return null;
    const scriptBlockStart = startLine + 1;
    const localPosition = getLocationInBlock(
      text,
      startLine,
      startLine + script.split("\n").length,
      INDENT_SIZE,
      {
        type: "line-column",
        line: params.position.line,
        column: params.position.character,
      },
      totalAdditionalPartChars,
    );
    if (!localPosition) return null;
    console.log(textLocationVisualizer(script, localPosition.localPosition));
    // 定義取得時は、以前の補正 localOffset + 1 を適用
    const localOffset = localPosition.localPosition.offset;
    const virtualPath = getVirtualFilePath(params.textDocument.uri);
    const definitions = tsService.getDefinitionAtPosition(
      virtualPath,
      localOffset + 1,
    );
    if (!definitions) return null;
    const results: Location[] = [];
    definitions.forEach((def) => {
      if (def.fileName === virtualPath) {
        const sourceFile = tsService.getProgram()?.getSourceFile(virtualPath);
        if (sourceFile) {
          const defStart = sourceFile.getLineAndCharacterOfPosition(
            def.textSpan.start,
          );
          const defEnd = sourceFile.getLineAndCharacterOfPosition(
            def.textSpan.start + def.textSpan.length,
          );
          results.push({
            uri: params.textDocument.uri,
            range: {
              start: {
                line:
                  defStart.line -
                  totalAdditionalPartLines +
                  scriptBlockStart -
                  1,
                character: defStart.character + INDENT_SIZE,
              },
              end: {
                line:
                  defEnd.line - totalAdditionalPartLines + scriptBlockStart - 1,
                character: defEnd.character + INDENT_SIZE,
              },
            },
          });
        }
      } else {
        const defUri = pathToFileURL(def.fileName).toString();
        const sourceFile = tsService.getProgram()?.getSourceFile(def.fileName);
        if (sourceFile) {
          const defStart = sourceFile.getLineAndCharacterOfPosition(
            def.textSpan.start,
          );
          const defEnd = sourceFile.getLineAndCharacterOfPosition(
            def.textSpan.start + def.textSpan.length,
          );
          results.push({
            uri: defUri,
            range: {
              start: {
                line: defStart.line,
                character: defStart.character,
              },
              end: {
                line: defEnd.line,
                character: defEnd.character,
              },
            },
          });
        }
      }
    });
    return results;
  });

  // 補完処理
  connection.onCompletion((params) => {
    setActiveFileFromUri(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const { script, startLine } = extractScript(text);
    if (!script) return [];
    const localPosition = getLocationInBlock(
      text,
      startLine,
      startLine + script.split("\n").length,
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

  documents.listen(connection);
  connection.listen();
}

init();
