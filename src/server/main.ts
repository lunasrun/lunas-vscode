import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  TextEdit,
  Range,
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

// HTML & CSS language services
import {
  getLanguageService as getHTMLLanguageService,
  HTMLDocument,
} from "vscode-html-languageservice/lib/esm/htmlLanguageService";
import {
  getCSSLanguageService,
  Stylesheet,
} from "vscode-css-languageservice/lib/esm/cssLanguageService";

async function init() {
  // LSP の接続作成
  const connection = createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments(
    TextDocument,
  );

  // initialize HTML & CSS services
  const htmlService = getHTMLLanguageService({});
  const cssService = getCSSLanguageService({});

  const INDENT_SIZE = 2;
  let totalAdditionalPartChars = 0;
  let totalAdditionalPartLines = 0;
  let extraTypings: string[] = [];

  connection.onInitialize((params: InitializeParams) => {
    // const workspaceFolders = params.workspaceFolders || [];
    // const workspaceRoot =
    //   workspaceFolders.length > 0
    //     ? new URL(workspaceFolders[0].uri).pathname
    //     : process.cwd();
    const workspaceRoot = process.env.PROJECT_ROOT ?? process.cwd();

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
    // ディレクトリの有無の判別を入れる
    if (!fs.existsSync(workspaceSrcRoot)) {
      // もしなければ {extensionのdir}/node_modulesを探す処理を追加する
      const extensionDir = path.dirname(__dirname);
      const alternativeSrcRoot = path.join(
        extensionDir,
        "node_modules",
        "lunas",
        "dist",
        "types",
      );
      if (fs.existsSync(alternativeSrcRoot)) {
        const files = fs.readdirSync(alternativeSrcRoot);
        const dtsFiles = files.filter((file) => file.endsWith(".d.ts"));
        extraTypings = dtsFiles.map((file) =>
          path.join(alternativeSrcRoot, file),
        );
      }
    } else {
      const files = fs.readdirSync(workspaceSrcRoot);
      const dtsFiles = files.filter((file) => file.endsWith(".d.ts"));
      extraTypings = dtsFiles.map((file) => path.join(workspaceSrcRoot, file));
    }

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: ["<", "/", " "],
        },
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

  // --- Helpers for HTML & CSS block extraction ---
  function extractHTML(text: string): {
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
    // Compute startLine from regex match index for precise block position
    const htmlKeywordIndex = match.index ?? text.indexOf("html:");
    const startLine = text.substring(0, htmlKeywordIndex).split("\n").length;
    const rawLines = full.split("\n");
    // Calculate minimal indent across non-empty lines
    const indentCounts = rawLines
      .filter((l) => l.trim() !== "")
      .map((l) => l.match(/^\s*/)![0].length);
    const minIndent = indentCounts.length > 0 ? Math.min(...indentCounts) : 0;
    console.debug(`[extractHTML] removing uniform indent: ${minIndent}`);
    const lines = rawLines.map((line) => {
      // Remove the minimal indent but preserve rest of content
      const content = line.startsWith(" ".repeat(minIndent))
        ? line.slice(minIndent)
        : line;
      console.debug(`[extractHTML] content: ${JSON.stringify(content)}`);
      // Sanitize malformed closing tags like "<//div" or "<//div>"
      const sanitized = content.replace(/<\/\/(\w+)>?/g, "</$1>");
      if (sanitized !== content) {
        console.warn(
          `[extractHTML] sanitized malformed tag: ${JSON.stringify(sanitized)}`,
        );
      }
      return sanitized;
    });
    return {
      html: lines.join("\n"),
      startLine,
      endLine: startLine + lines.length - 1,
      indent: minIndent,
    };
  }
  function extractStyle(text: string): {
    css: string;
    startLine: number;
    endLine: number;
  } {
    const match = text.match(/style:\s*\n([\s\S]*?)(?:\n\s*(script:|html:)|$)/);
    if (!match) return { css: "", startLine: 0, endLine: 0 };
    const full = match[1];
    const startLine = text
      .substring(0, text.indexOf("style:"))
      .split("\n").length;
    const lines = full
      .split("\n")
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line));
    return {
      css: lines.join("\n"),
      startLine,
      endLine: startLine + lines.length - 1,
    };
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
    getDefaultLibFileName: (options) => {
      const userTSLib = path.join(
        process.env.PROJECT_ROOT ?? process.cwd(),
        "node_modules",
        "typescript",
        "lib",
      );
      const fallbackTSLib = path.join(
        __dirname,
        "..",
        "node_modules",
        "typescript",
        "lib",
      );

      const libFile = ts.getDefaultLibFileName(options);
      const userLibPath = path.join(userTSLib, libFile);
      const fallbackLibPath = path.join(fallbackTSLib, libFile);

      if (fs.existsSync(userLibPath)) {
        return userLibPath;
      } else {
        return fallbackLibPath;
      }
    },
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
    // console.log(textLocationVisualizer(script, localPosition.localPosition));
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

  // 補完処理 (HTML, CSS, TS)
  connection.onCompletion((params) => {
    const uri = params.textDocument.uri;
    const doc = documents.get(uri);
    if (!doc) return [];
    const text = doc.getText();
    const pos = params.position;

    // HTML completions
    const {
      html,
      startLine: hStart,
      endLine: hEnd,
      indent,
    } = extractHTML(text);
    if (html && pos.line >= hStart && pos.line <= hEnd) {
      // Debug original document position and block info
      console.debug(
        `[HTML Completion] Original position: line=${pos.line}, char=${pos.character}`,
      );
      console.debug(
        `[HTML Completion] HTML block lines ${hStart}-${hEnd}, indent=${indent}`,
      );
      const relLine = pos.line - hStart;
      let relChar = pos.character - indent;
      if (relChar < 0) relChar = 0;
      console.debug(
        `[HTML Completion] Relative position: relLine=${relLine}, relChar=${relChar}`,
      );
      // Show surrounding context
      const contextLines = html
        .split("\n")
        .slice(Math.max(0, relLine - 2), relLine + 3);
      console.debug(
        `[HTML Completion] Context around cursor:\n${contextLines.join("\n")}`,
      );
      // Create a proper TextDocument for HTML
      const htmlTextDoc = TextDocument.create(uri, "html", doc.version, html);
      const htmlParsedDoc = htmlService.parseHTMLDocument(htmlTextDoc);
      const comps = htmlService.doComplete(
        htmlTextDoc,
        { line: relLine, character: relChar },
        htmlParsedDoc,
      );
      console.debug(`[HTML Completion] Received ${comps.items.length} items`);
      console.debug(
        `[HTML Completion] Raw items: ${JSON.stringify(comps.items, null, 2)}`,
      );
      return comps.items.map((item) => {
        console.debug(
          `[HTML Completion] Mapping item: ${JSON.stringify(item)}`,
        );
        // The HTML service gives ranges relative to the HTML fragment.
        // We need to shift them back to the full document.
        const edit = item.textEdit!;
        let adjustedTextEdit: TextEdit | undefined = undefined;
        if ("range" in edit) {
          // TextEdit
          const origRange = edit.range;
          const adjustedRange: Range = Range.create(
            origRange.start.line + hStart,
            origRange.start.character + indent,
            origRange.end.line + hStart,
            origRange.end.character + indent,
          );
          adjustedTextEdit = {
            range: adjustedRange,
            newText: edit.newText,
          };
        } else if ("insert" in edit && "replace" in edit) {
          // InsertReplaceEdit: map both insert and replace ranges
          const origInsert = edit.insert;
          const origReplace = edit.replace;
          const adjustedInsert: Range = Range.create(
            origInsert.start.line + hStart,
            origInsert.start.character + indent,
            origInsert.end.line + hStart,
            origInsert.end.character + indent,
          );
          const adjustedReplace: Range = Range.create(
            origReplace.start.line + hStart,
            origReplace.start.character + indent,
            origReplace.end.line + hStart,
            origReplace.end.character + indent,
          );
          // Convert InsertReplaceEdit to TextEdit by using the replace range
          adjustedTextEdit = {
            range: adjustedReplace,
            newText: edit.newText,
          };
        }
        const completion: CompletionItem = {
          label: item.label,
          kind: CompletionItemKind.Text,
          documentation: item.documentation,
          detail: item.detail,
          textEdit: adjustedTextEdit,
          insertTextFormat: item.insertTextFormat ?? InsertTextFormat.PlainText,
        };
        return completion;
      });
    }

    // CSS completions
    const { css, startLine: cStart, endLine: cEnd } = extractStyle(text);
    if (css && pos.line >= cStart && pos.line <= cEnd) {
      // Create a proper TextDocument for CSS
      const cssTextDoc = TextDocument.create(uri, "css", doc.version, css);
      const cssParsedStylesheet = cssService.parseStylesheet(cssTextDoc);
      const comps = cssService.doComplete(
        cssTextDoc,
        { line: pos.line - cStart, character: pos.character },
        cssParsedStylesheet,
      );
      return comps.items.map((item) => {
        if (!item.textEdit) return item;

        let adjustedTextEdit: TextEdit | undefined = undefined;

        // Handle TextEdit (has 'range') and InsertReplaceEdit (has 'insert' and 'replace')
        if ("range" in item.textEdit) {
          const origRange = item.textEdit.range;
          const adjustedRange = {
            start: {
              line: origRange.start.line + cStart,
              character: origRange.start.character + indent,
            },
            end: {
              line: origRange.end.line + cStart,
              character: origRange.end.character + indent,
            },
          };
          adjustedTextEdit = {
            range: adjustedRange,
            newText: item.textEdit.newText,
          };
        } else if ("insert" in item.textEdit && "replace" in item.textEdit) {
          // InsertReplaceEdit: map both insert and replace ranges
          const origInsert = item.textEdit.insert;
          const origReplace = item.textEdit.replace;
          const adjustedInsert = {
            start: {
              line: origInsert.start.line + cStart,
              character: origInsert.start.character + indent,
            },
            end: {
              line: origInsert.end.line + cStart,
              character: origInsert.end.character + indent,
            },
          };
          const adjustedReplace = {
            start: {
              line: origReplace.start.line + cStart,
              character: origReplace.start.character + indent,
            },
            end: {
              line: origReplace.end.line + cStart,
              character: origReplace.end.character + indent,
            },
          };
          // Convert InsertReplaceEdit to TextEdit by using the replace range
          adjustedTextEdit = {
            range: adjustedReplace,
            newText: item.textEdit.newText,
          };
        }

        return {
          label: item.label,
          kind: CompletionItemKind.Text,
          documentation: item.documentation,
          detail: item.detail,
          textEdit: adjustedTextEdit,
          insertTextFormat: item.insertTextFormat ?? InsertTextFormat.Snippet,
        };
      });
    }

    // Fallback to TypeScript completions
    setActiveFileFromUri(uri);
    const { script, startLine } = extractScript(text);
    if (!script) return [];
    const localPosition = getLocationInBlock(
      text,
      startLine,
      startLine + script.split("\n").length,
      INDENT_SIZE,
      { type: "line-column", line: pos.line, column: pos.character },
      totalAdditionalPartChars,
    );
    if (!localPosition) return [];
    const localOffset = localPosition.localPosition.offset;
    const virtualPath = getVirtualFilePath(uri);
    const tsComps = tsService.getCompletionsAtPosition(
      virtualPath,
      localOffset,
      {},
    );
    if (!tsComps) return [];
    return tsComps.entries.map((entry) => ({
      label: entry.name,
      kind: CompletionItemKind.Text,
    }));
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
