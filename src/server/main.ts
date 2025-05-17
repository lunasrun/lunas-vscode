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
  Position, // Added for clarity
  CompletionParams, // Added for clarity
  HoverParams, // Added for clarity
  DefinitionParams, // Added for clarity
  CompletionItemTag,
} from "vscode-languageserver/node";
import * as fs from "fs";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  getLocationInBlock,
  // textLocationVisualizer, // Not used in the final provided code snippet by user
} from "./utils/text-location";

// HTML & CSS language services
import {
  getLanguageService as getHTMLLanguageService,
  // HTMLDocument, // Not directly used, parseHTMLDocument is used
  TokenType,
} from "vscode-html-languageservice/lib/esm/htmlLanguageService";
import {
  getCSSLanguageService,
  // Stylesheet, // Not directly used, parseStylesheet is used
} from "vscode-css-languageservice/lib/esm/cssLanguageService";
import {
  extractScript,
  extractInputs,
  extractHTML,
  extractStyle,
  findAndReadTSConfig,
  getVirtualFilePath,
  setActiveFileFromUri,
} from "./utils/lunas-blocks";

// 仮想ファイルの内容とバージョンを管理
const scriptContents = new Map<string, string>();
const scriptVersions = new Map<string, number>();
const tsConfigCache = new Map<string, ts.ParsedCommandLine>();

// 現在リクエスト対象のファイルの仮想パスを保持
let activeVirtualFile: string | null = null;

// Helper to map TypeScript completion kinds to LSP completion kinds
function mapTsCompletionKind(kind: ts.ScriptElementKind): CompletionItemKind {
  switch (kind) {
    case ts.ScriptElementKind.primitiveType:
    case ts.ScriptElementKind.keyword:
      return CompletionItemKind.Keyword;
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.constElement:
    case ts.ScriptElementKind.letElement:
      return CompletionItemKind.Variable;
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.callSignatureElement:
    case ts.ScriptElementKind.indexSignatureElement:
    case ts.ScriptElementKind.constructSignatureElement:
      return CompletionItemKind.Function;
    case ts.ScriptElementKind.parameterElement:
      return CompletionItemKind.TypeParameter; // Or Variable
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return CompletionItemKind.Module;
    case ts.ScriptElementKind.classElement:
    case ts.ScriptElementKind.typeElement: // type alias
      return CompletionItemKind.Class; // Or Struct, TypeParameter for type alias
    case ts.ScriptElementKind.interfaceElement:
      return CompletionItemKind.Interface;
    case ts.ScriptElementKind.enumElement:
      return CompletionItemKind.Enum;
    case ts.ScriptElementKind.enumMemberElement:
      return CompletionItemKind.EnumMember;
    case ts.ScriptElementKind.alias:
      return CompletionItemKind.Reference;
    case ts.ScriptElementKind.scriptElement:
      return CompletionItemKind.File;
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Property;
    case ts.ScriptElementKind.constructorImplementationElement:
      return CompletionItemKind.Constructor;
    case ts.ScriptElementKind.string:
      return CompletionItemKind.Text; // Or Value
    default:
      return CompletionItemKind.Text;
  }
}

// --- BEGINNING OF LSP SERVER CODE ---
async function init() {
  const connection = createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments(
    TextDocument,
  );

  const htmlService = getHTMLLanguageService({});
  const cssService = getCSSLanguageService({});

  const INDENT_SIZE = 2; // Assuming this is the script block indent. HTML indent might differ.
  let totalAdditionalPartChars = 0;
  let totalAdditionalPartLines = 0;
  let extraTypings: string[] = [];

  connection.onInitialize((params: InitializeParams) => {
    const workspaceRoot = process.env.PROJECT_ROOT ?? process.cwd();
    const workspaceSrcRoot = path.join(
      workspaceRoot,
      "node_modules",
      "lunas",
      "dist",
      "types",
    );
    if (!fs.existsSync(workspaceSrcRoot)) {
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
          triggerCharacters: ["<", "/", " ", ".", '"', "'", "`", "$", "{", ":"], // Added trigger chars
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
        try {
          // Add try-catch for robustness
          return ts.ScriptSnapshot.fromString(
            fs.readFileSync(fileName, "utf-8"),
          );
        } catch (e) {
          console.error(`Error reading file for snapshot: ${fileName}`, e);
          return undefined;
        }
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
      const config = tsConfigCache.get(dir);
      return config
        ? config.options
        : { ...ts.getDefaultCompilerOptions(), jsx: ts.JsxEmit.Preserve }; // Added JSX for potential TSX like features
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
      return fs.existsSync(userLibPath) ? userLibPath : fallbackLibPath;
    },
    readFile: (fileName) =>
      fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : undefined,
    fileExists: (fileName) =>
      scriptContents.has(fileName) || fs.existsSync(fileName),
    // Added for better module resolution if needed, can be expanded
    resolveModuleNames: (moduleNames, containingFile) => {
      const resolvedModules: ts.ResolvedModule[] = [];
      const compilerOptions = tsHost.getCompilationSettings();
      for (const moduleName of moduleNames) {
        const result = ts.resolveModuleName(
          moduleName,
          containingFile,
          compilerOptions,
          {
            fileExists: tsHost.fileExists,
            readFile: tsHost.readFile,
          },
        );
        if (result.resolvedModule) {
          resolvedModules.push(result.resolvedModule);
        }
      }
      return resolvedModules;
    },
  };

  const tsService = ts.createLanguageService(tsHost);

  documents.onDidChangeContent((change) => {
    const text = change.document.getText();
    const uri = change.document.uri;
    const virtualPath = getVirtualFilePath(uri);
    activeVirtualFile = virtualPath;

    const { script, startLine } = extractScript(text);
    const inputs = extractInputs(text);
    const inputDeclarations =
      Object.entries(inputs)
        .map(([name, type]) => `declare let ${name}: ${type};`)
        .join("\n") + "\n";

    totalAdditionalPartChars = inputDeclarations.length; // This is for script block context
    totalAdditionalPartLines = inputDeclarations.split("\n").length - 1;
    const updatedScript = `${inputDeclarations}${script}`;

    if (scriptContents.get(virtualPath) !== updatedScript) {
      scriptContents.set(virtualPath, updatedScript);
      scriptVersions.set(
        virtualPath,
        (scriptVersions.get(virtualPath) || 0) + 1,
      );
    }

    const scriptBlockStartLine = startLine + 1; // Actual start line of script content

    const diagnostics: Diagnostic[] = [];
    // Ensure program is updated
    tsService.getProgram(); // This helps ensure the program is up-to-date with latest script versions.

    const syntaxDiagnostics = tsService.getSyntacticDiagnostics(virtualPath);
    const semanticDiagnostics = tsService.getSemanticDiagnostics(virtualPath);

    [...syntaxDiagnostics, ...semanticDiagnostics].forEach((tsDiag) => {
      if (
        tsDiag.file &&
        tsDiag.start !== undefined &&
        tsDiag.file.fileName === virtualPath
      ) {
        // Process only diagnostics for the current virtual file
        // Check if the diagnostic is within the input declarations part
        if (tsDiag.start < totalAdditionalPartChars) return; // Skip diagnostics from injected input declarations

        const diagStartPos = tsDiag.file.getLineAndCharacterOfPosition(
          tsDiag.start,
        );
        const diagEndPos = tsDiag.file.getLineAndCharacterOfPosition(
          tsDiag.start + (tsDiag.length || 0),
        );

        diagnostics.push({
          severity: DiagnosticSeverity.Error, // Map tsDiag.category
          range: {
            start: {
              line:
                diagStartPos.line -
                totalAdditionalPartLines +
                scriptBlockStartLine -
                1,
              character: diagStartPos.character + INDENT_SIZE, // Assuming script is indented
            },
            end: {
              line:
                diagEndPos.line -
                totalAdditionalPartLines +
                scriptBlockStartLine -
                1,
              character: diagEndPos.character + INDENT_SIZE, // Assuming script is indented
            },
          },
          message: ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n"),
          source: "Lunas TS",
        });
      }
    });
    connection.sendDiagnostics({ uri, diagnostics });
  });

  documents.onDidClose((change) => {
    const virtualPath = getVirtualFilePath(change.document.uri);
    scriptContents.delete(virtualPath);
    scriptVersions.delete(virtualPath);
    // tsConfigCache.delete(path.dirname(virtualPath)); // Optionally clear tsconfig cache
    if (activeVirtualFile === virtualPath) {
      activeVirtualFile = null;
    }
  });

  /**
   * Helper to analyze if the cursor is within a Lunas template expression
   * and return context for TS interaction.
   */
  function getLunasTemplateContext(
    htmlTextDoc: TextDocument,
    htmlBlockPosition: Position, // Position relative to the HTML block
    htmlService: ReturnType<typeof getHTMLLanguageService>,
  ): {
    expression: string;
    offsetInExpression: number;
    expressionStartInHtmlBlock: Position;
    type: "interpolation" | "attribute";
    attributeName?: string;
    forScope?: { itemVar: string; indexVar?: string; collectionExpr: string };
  } | null {
    const offsetInHtmlBlock = htmlTextDoc.offsetAt(htmlBlockPosition);
    const htmlContent = htmlTextDoc.getText();
    const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
    const nodeAtCursor = parsedHtmlDoc.findNodeAt(offsetInHtmlBlock);

    // 1. Check for interpolation: ${expression}
    // A more robust way than regex for whole content: check text around cursor
    const charBeforeCursor = htmlContent.charAt(offsetInHtmlBlock - 1);
    const charAfterCursor = htmlContent.charAt(offsetInHtmlBlock);

    let scanStart = Math.max(0, offsetInHtmlBlock - 100); // Scan a window around cursor
    let scanEnd = Math.min(htmlContent.length, offsetInHtmlBlock + 100);
    let windowText = htmlContent.substring(scanStart, scanEnd);
    let cursorInWindow = offsetInHtmlBlock - scanStart;

    const interpolationRegex = /\$\{([^}]*)\}/g;
    let match;
    while ((match = interpolationRegex.exec(htmlContent)) !== null) {
      const exprStartOffset = match.index + 2;
      const exprEndOffset = exprStartOffset + match[1].length;
      if (
        offsetInHtmlBlock >= exprStartOffset &&
        offsetInHtmlBlock <= exprEndOffset
      ) {
        return {
          expression: match[1],
          offsetInExpression: offsetInHtmlBlock - exprStartOffset,
          expressionStartInHtmlBlock: htmlTextDoc.positionAt(exprStartOffset),
          type: "interpolation",
        };
      }
    }

    // 2. Check for attribute bindings: :attr="expression", ::attr="expression", :if="expression", :for="loop"
    if (nodeAtCursor && nodeAtCursor.attributes) {
      for (const attrName in nodeAtCursor.attributes) {
        if (attrName.startsWith(":")) {
          const attrValueWithQuotes = nodeAtCursor.attributes[attrName];
          if (attrValueWithQuotes === null || attrValueWithQuotes === undefined)
            continue;

          const attrValue = attrValueWithQuotes.slice(1, -1); // Remove quotes

          // Calculate the start/end of the attribute value within the HTML block
          // This is tricky; html-languageservice doesn't directly give offsets for attribute *values*.
          // We need to find the attribute in the node's text.
          const nodeText = htmlContent.substring(
            nodeAtCursor.start,
            nodeAtCursor.startTagEnd ?? nodeAtCursor.end,
          );
          const attrFullString = `${attrName}=${attrValueWithQuotes}`;
          const attrValueOffsetInNode = nodeText.indexOf(attrFullString);
          if (attrValueOffsetInNode === -1) continue;

          const valueStartOffsetInNode =
            attrValueOffsetInNode + attrName.length + 2; // Past attrName="
          const expressionStartInHtmlBlockOffset =
            nodeAtCursor.start + valueStartOffsetInNode;
          const expressionEndInHtmlBlockOffset =
            expressionStartInHtmlBlockOffset + attrValue.length;

          if (
            offsetInHtmlBlock >= expressionStartInHtmlBlockOffset &&
            offsetInHtmlBlock <= expressionEndInHtmlBlockOffset
          ) {
            let forScope:
              | { itemVar: string; indexVar?: string; collectionExpr: string }
              | undefined = undefined;
            if (attrName === ":for") {
              // Basic parsing for ":for=[item, index] of collection" or ":for=item of collection"
              const forMatch = attrValue.match(
                /^(?:\[\s*(\w+)\s*(?:,\s*(\w+)\s*)?\]|(\w+))\s+of\s+(.+)$/,
              );
              if (forMatch) {
                const itemVar = forMatch[1] || forMatch[3];
                const indexVar = forMatch[2];
                const collectionExpr = forMatch[4];
                if (itemVar) {
                  // Check if cursor is on collectionExpr part
                  const collectionOffsetInAttr =
                    attrValue.lastIndexOf(collectionExpr);
                  if (collectionOffsetInAttr !== -1) {
                    const cursorInAttrValue =
                      offsetInHtmlBlock - expressionStartInHtmlBlockOffset;
                    if (cursorInAttrValue >= collectionOffsetInAttr) {
                      return {
                        expression: collectionExpr,
                        offsetInExpression:
                          cursorInAttrValue - collectionOffsetInAttr,
                        expressionStartInHtmlBlock: htmlTextDoc.positionAt(
                          expressionStartInHtmlBlockOffset +
                            collectionOffsetInAttr,
                        ),
                        type: "attribute",
                        attributeName: attrName,
                      };
                    }
                    // If cursor is on itemVar or indexVar, specific handling might be needed (e.g. no TS completion, or treat as declaration)
                    // For now, this example focuses on expressions that refer to script variables.
                  }
                }
                // If trying to complete itemVar or indexVar, that's a declaration, not an expression to complete from script.
                // This part would need more advanced logic for refactoring/renaming, not just completion.
                // If cursor is on item/index, we might not want TS completions from the main script.
                const cursorRelativeOffsetInAttr =
                  offsetInHtmlBlock - expressionStartInHtmlBlockOffset;
                if (cursorRelativeOffsetInAttr < attrValue.indexOf(" of ")) {
                  // Cursor is on the variable declaration part
                  return null; // Don't provide TS completion for the loop variable declaration itself
                }
              }
            }
            // For other attributes or the collection part of :for
            return {
              expression: attrValue,
              offsetInExpression:
                offsetInHtmlBlock - expressionStartInHtmlBlockOffset,
              expressionStartInHtmlBlock: htmlTextDoc.positionAt(
                expressionStartInHtmlBlockOffset,
              ),
              type: "attribute",
              attributeName: attrName,
              forScope: forScope, // This would be more complex to populate for expressions *inside* the :for body
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Wraps the expression from template with context from script and :for scope.
   * Returns the modified script and the new offset within this modified script.
   */
  function prepareTemporaryScriptForExpression(
    originalScriptContent: string,
    expression: string,
    htmlNodeForScope: any, // Pass the HTML AST node to check for :for ancestors
    htmlDoc: TextDocument, // Full HTML document for parsing :for
    htmlService: ReturnType<typeof getHTMLLanguageService>,
  ): {
    tempScript: string;
    expressionOffsetInTempScript: number;
    forVars: { name: string; type: string }[];
  } {
    let prefix = originalScriptContent + "\n;(() => {\n";
    const forVars: { name: string; type: string }[] = [];

    // Simplified :for scope detection: check current node and direct parent
    // A proper implementation would walk up the AST.
    let currentNode = htmlNodeForScope;
    const visitedNodes = new Set(); // To avoid infinite loops with circular parent references if any

    while (currentNode && !visitedNodes.has(currentNode)) {
      visitedNodes.add(currentNode);
      if (currentNode.attributes && currentNode.attributes[":for"]) {
        const forValue = currentNode.attributes[":for"].slice(1, -1);
        const forMatch = forValue.match(
          /^(?:\[\s*(\w+)\s*(?:,\s*(\w+)\s*)?\]|(\w+))\s+of\s+(.+)$/,
        );
        if (forMatch) {
          const itemVar = forMatch[1] || forMatch[3];
          const indexVar = forMatch[2];
          // Attempt to infer type of itemVar if possible, otherwise 'any'
          // For simplicity, using 'any' for now.
          if (itemVar) {
            prefix += `let ${itemVar}: any;\n`; // Declare loop variable
            forVars.push({ name: itemVar, type: "any" });
          }
          if (indexVar) {
            prefix += `let ${indexVar}: number;\n`; // Index is usually number
            forVars.push({ name: indexVar, type: "number" });
          }
        }
      }
      if (!currentNode.parent) break; // Stop if no parent
      // To get parent for current node, we'd need to re-parse or navigate carefully.
      // htmlService.parseHTMLDocument(htmlDoc).findNodeAt(currentNode.start-1) might give parent if lucky.
      // This part is complex with current html-language-service API for parent traversal.
      // For robust :for scope, a full AST traversal from root to nodeAtCursor would be better to collect scopes.
      // This simplified version only checks the immediate node.
      break; // Simplified: only check current node for :for scope for variables inside its *attributes*
      // For variables *inside the content* of a :for element, this logic needs to be in getLunasTemplateContext or called differently.
    }

    const tempScript = prefix + "return (" + expression + ");\n})();\n";
    const expressionOffsetInTempScript = prefix.length + "return (".length;
    return { tempScript, expressionOffsetInTempScript, forVars };
  }

  connection.onCompletion(
    (params: CompletionParams): CompletionItem[] | null => {
      const uri = params.textDocument.uri;
      const doc = documents.get(uri);
      if (!doc) return null;

      const text = doc.getText();
      const position = params.position;
      let currentActiveVirtualFile = activeVirtualFile; // Use cached active file

      // Ensure virtual file is set and its content is loaded
      if (!currentActiveVirtualFile) {
        setActiveFileFromUri(uri, (v) => (currentActiveVirtualFile = v));
        if (!currentActiveVirtualFile) return null;
        if (!scriptContents.has(currentActiveVirtualFile)) {
          const {
            script: currentFileScript,
            startLine: currentFileScriptStartLine,
          } = extractScript(text);
          const currentFileInputs = extractInputs(text);
          const currentFileInputDeclarations =
            Object.entries(currentFileInputs)
              .map(([name, type]) => `declare let ${name}: ${type};`)
              .join("\n") + "\n";
          const updatedCurrentFileScript = `${currentFileInputDeclarations}${currentFileScript}`;
          scriptContents.set(
            currentActiveVirtualFile,
            updatedCurrentFileScript,
          );
          scriptVersions.set(
            currentActiveVirtualFile,
            (scriptVersions.get(currentActiveVirtualFile) || 0) + 1,
          );
          totalAdditionalPartChars = currentFileInputDeclarations.length; // Update for current file
          totalAdditionalPartLines =
            currentFileInputDeclarations.split("\n").length - 1;
        }
      }
      const virtualPath = currentActiveVirtualFile;

      // HTML Block Completions
      const {
        html,
        startLine: hStart,
        endLine: hEnd,
        indent: htmlIndent,
      } = extractHTML(text);
      if (html && position.line >= hStart && position.line <= hEnd) {
        const htmlTextDoc = TextDocument.create(uri, "html", doc.version, html);
        const relPosInHtmlBlock = Position.create(
          position.line - hStart,
          position.character - htmlIndent,
        );

        // Check if cursor is within a Lunas template expression
        const templateContext = getLunasTemplateContext(
          htmlTextDoc,
          relPosInHtmlBlock,
          htmlService,
        );

        if (templateContext && virtualPath) {
          const originalScriptContent = scriptContents.get(virtualPath);
          if (!originalScriptContent) return null;

          const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
          const nodeAtCursor = parsedHtmlDoc.findNodeAt(
            htmlTextDoc.offsetAt(relPosInHtmlBlock),
          );

          const { tempScript, expressionOffsetInTempScript, forVars } =
            prepareTemporaryScriptForExpression(
              originalScriptContent,
              templateContext.expression,
              nodeAtCursor, // Pass the HTML node for :for scope checking
              htmlTextDoc,
              htmlService,
            );

          const originalVersion = scriptVersions.get(virtualPath) || 0;
          scriptContents.set(virtualPath, tempScript);
          scriptVersions.set(virtualPath, originalVersion + 1);

          const tsCompletions = tsService.getCompletionsAtPosition(
            virtualPath,
            expressionOffsetInTempScript + templateContext.offsetInExpression,
            {},
          );

          // Restore original script
          scriptContents.set(virtualPath, originalScriptContent);
          scriptVersions.set(virtualPath, originalVersion + 2); // Increment version again

          if (tsCompletions) {
            return tsCompletions.entries.map((entry) => {
              const exprStartInFullDoc = Position.create(
                templateContext.expressionStartInHtmlBlock.line + hStart,
                templateContext.expressionStartInHtmlBlock.character +
                  htmlIndent,
              );
              // Ensure range for replacement is valid and relative to expression start
              const startOffsetInExpression =
                templateContext.offsetInExpression - entry.name.length + 1; // Heuristic for what to replace
              const endOffsetInExpression = templateContext.offsetInExpression;

              // Create range within the expression in the original document
              const replacementStartPos = doc.positionAt(
                doc.offsetAt(exprStartInFullDoc) +
                  Math.max(
                    0,
                    templateContext.offsetInExpression - entry.name.length,
                  ),
              );
              const replacementEndPos = doc.positionAt(
                doc.offsetAt(exprStartInFullDoc) +
                  templateContext.offsetInExpression,
              );

              return {
                label: entry.name,
                kind: mapTsCompletionKind(entry.kind),
                textEdit: TextEdit.replace(
                  Range.create(replacementStartPos, replacementEndPos), // This range needs to be precise
                  entry.name,
                ),
                insertTextFormat: InsertTextFormat.PlainText,
                data: {
                  virtualPath: virtualPath, // For resolve
                  tsOffset:
                    expressionOffsetInTempScript +
                    templateContext.offsetInExpression, // For resolve
                  entryName: entry.name,
                },
              };
            });
          }
        }

        // Fallback to standard HTML completions
        const htmlComps = htmlService.doComplete(
          htmlTextDoc,
          relPosInHtmlBlock,
          htmlService.parseHTMLDocument(htmlTextDoc),
        );
        return htmlComps.items.map((item) => {
          let adjustedTextEdit: TextEdit | undefined = undefined;
          if (item.textEdit && TextEdit.is(item.textEdit)) {
            const origRange = item.textEdit.range;
            adjustedTextEdit = TextEdit.replace(
              Range.create(
                origRange.start.line + hStart,
                origRange.start.character + htmlIndent,
                origRange.end.line + hStart,
                origRange.end.character + htmlIndent,
              ),
              item.textEdit.newText,
            );
          }
          return { ...item, textEdit: adjustedTextEdit };
        });
      }

      // CSS Block Completions (similar to existing, ensure relative positions are correct)
      const {
        css,
        startLine: cStart,
        endLine: cEnd,
        indent: cssIndent,
      } = extractStyle(text); // Assuming indent for CSS too
      if (css && position.line >= cStart && position.line <= cEnd) {
        const cssTextDoc = TextDocument.create(uri, "css", doc.version, css);
        const relPosInCssBlock = Position.create(
          position.line - cStart,
          position.character - (cssIndent ?? INDENT_SIZE),
        );
        const cssComps = cssService.doComplete(
          cssTextDoc,
          relPosInCssBlock,
          cssService.parseStylesheet(cssTextDoc),
        );
        return cssComps.items.map((item) => {
          let adjustedTextEdit: TextEdit | undefined = undefined;
          if (item.textEdit && TextEdit.is(item.textEdit)) {
            const origRange = item.textEdit.range;
            adjustedTextEdit = TextEdit.replace(
              Range.create(
                origRange.start.line + cStart,
                origRange.start.character + (cssIndent ?? INDENT_SIZE),
                origRange.end.line + cStart,
                origRange.end.character + (cssIndent ?? INDENT_SIZE),
              ),
              item.textEdit.newText,
            );
          }
          return { ...item, textEdit: adjustedTextEdit };
        });
      }

      // Script Block Completions
      const { script, startLine: scriptDeclLine } = extractScript(text);
      if (script && virtualPath) {
        const scriptContentActualStartLine = scriptDeclLine + 1;
        // Check if cursor is within the script block
        const scriptLines = script.split("\n");
        const scriptContentActualEndLine =
          scriptContentActualStartLine + scriptLines.length - 1;

        if (
          position.line >= scriptContentActualStartLine &&
          position.line <= scriptContentActualEndLine
        ) {
          const localPositionResult = getLocationInBlock(
            text, // full original text
            scriptDeclLine, // line of "script:"
            scriptContentActualEndLine,
            INDENT_SIZE, // script block's own indent
            {
              type: "line-column",
              line: position.line,
              column: position.character,
            },
            totalAdditionalPartChars, // from input declarations
          );

          if (localPositionResult) {
            const tsCompletions = tsService.getCompletionsAtPosition(
              virtualPath,
              localPositionResult.localPosition.offset,
              {},
            );
            if (tsCompletions) {
              return tsCompletions.entries.map((entry) => ({
                label: entry.name,
                kind: mapTsCompletionKind(entry.kind),
                data: {
                  // For onCompletionResolve
                  virtualPath: virtualPath,
                  tsOffset: localPositionResult.localPosition.offset,
                  entryName: entry.name,
                },
              }));
            }
          }
        }
      }
      return null;
    },
  );

  connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    if (
      item.data &&
      item.data.virtualPath &&
      typeof item.data.tsOffset === "number" &&
      item.data.entryName
    ) {
      const { virtualPath, tsOffset, entryName } = item.data as {
        virtualPath: string;
        tsOffset: number;
        entryName: string;
      };

      // Temporarily set activeVirtualFile for this operation if it's different.
      // This is a workaround. Ideally, tsService methods should take filename directly
      // and tsHost should provide files without relying on a single activeVirtualFile.
      const previousActiveFile = activeVirtualFile;
      activeVirtualFile = virtualPath; // Ensure tsHost->getScriptFileNames includes this

      const details = tsService.getCompletionEntryDetails(
        virtualPath,
        tsOffset,
        entryName,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      activeVirtualFile = previousActiveFile; // Restore

      if (details) {
        item.detail = ts.displayPartsToString(details.displayParts);
        item.documentation = {
          kind: "markdown",
          value:
            ts.displayPartsToString(details.documentation || []) +
            (details.tags
              ? "\n\n" +
                details.tags
                  .map(
                    (tag) =>
                      `*@${tag.name}* ${ts.displayPartsToString(tag.text || [])}`,
                  )
                  .join("\n")
              : ""),
        };
      }
    }
    return item;
  });

  connection.onHover((params: HoverParams): Hover | null => {
    const uri = params.textDocument.uri;
    const doc = documents.get(uri);
    if (!doc) return null;

    const text = doc.getText();
    const position = params.position;
    let currentActiveVirtualFile = activeVirtualFile;

    if (!currentActiveVirtualFile) {
      setActiveFileFromUri(uri, (v) => (currentActiveVirtualFile = v));
      if (!currentActiveVirtualFile) return null;
      if (!scriptContents.has(currentActiveVirtualFile)) {
        // Ensure script content is loaded
        const {
          script: currentFileScript,
          startLine: currentFileScriptStartLine,
        } = extractScript(text);
        const currentFileInputs = extractInputs(text);
        const currentFileInputDeclarations =
          Object.entries(currentFileInputs)
            .map(([name, type]) => `declare let ${name}: ${type};`)
            .join("\n") + "\n";
        const updatedCurrentFileScript = `${currentFileInputDeclarations}${currentFileScript}`;
        scriptContents.set(currentActiveVirtualFile, updatedCurrentFileScript);
        scriptVersions.set(
          currentActiveVirtualFile,
          (scriptVersions.get(currentActiveVirtualFile) || 0) + 1,
        );
        totalAdditionalPartChars = currentFileInputDeclarations.length;
        totalAdditionalPartLines =
          currentFileInputDeclarations.split("\n").length - 1;
      }
    }
    const virtualPath = currentActiveVirtualFile;

    // HTML Block Hover
    const {
      html,
      startLine: hStart,
      endLine: hEnd,
      indent: htmlIndent,
    } = extractHTML(text);
    if (html && position.line >= hStart && position.line <= hEnd) {
      const htmlTextDoc = TextDocument.create(uri, "html", doc.version, html);
      const relPosInHtmlBlock = Position.create(
        position.line - hStart,
        position.character - htmlIndent,
      );
      const templateContext = getLunasTemplateContext(
        htmlTextDoc,
        relPosInHtmlBlock,
        htmlService,
      );

      if (templateContext && virtualPath) {
        const originalScriptContent = scriptContents.get(virtualPath);
        if (!originalScriptContent) return null;

        const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
        const nodeAtCursor = parsedHtmlDoc.findNodeAt(
          htmlTextDoc.offsetAt(relPosInHtmlBlock),
        );

        const { tempScript, expressionOffsetInTempScript } =
          prepareTemporaryScriptForExpression(
            originalScriptContent,
            templateContext.expression,
            nodeAtCursor,
            htmlTextDoc,
            htmlService,
          );

        const originalVersion = scriptVersions.get(virtualPath) || 0;
        scriptContents.set(virtualPath, tempScript);
        scriptVersions.set(virtualPath, originalVersion + 1);

        const quickInfo = tsService.getQuickInfoAtPosition(
          virtualPath,
          expressionOffsetInTempScript + templateContext.offsetInExpression,
        );

        scriptContents.set(virtualPath, originalScriptContent);
        scriptVersions.set(virtualPath, originalVersion + 2);

        if (quickInfo) {
          const displayString = ts.displayPartsToString(quickInfo.displayParts);
          const docString = ts.displayPartsToString(quickInfo.documentation);
          const contents = `**${displayString}**\n\n${docString}`;
          // Calculate range in original document for the hover highlight
          const exprStartInFullDoc = Position.create(
            templateContext.expressionStartInHtmlBlock.line + hStart,
            templateContext.expressionStartInHtmlBlock.character + htmlIndent,
          );
          const hoverRange = Range.create(
            doc.positionAt(
              doc.offsetAt(exprStartInFullDoc) +
                templateContext.offsetInExpression -
                (quickInfo.textSpan.length > 0 ? 0 : 0),
            ), // Adjust start based on what quickInfo refers to
            doc.positionAt(
              doc.offsetAt(exprStartInFullDoc) +
                templateContext.offsetInExpression +
                quickInfo.textSpan.length,
            ),
          );
          return {
            contents: { kind: "markdown", value: contents },
            range: hoverRange,
          };
        }
      }
      // Standard HTML hover can be added here if needed, htmlService.doHover(...)
    }

    // Script Block Hover
    const { script, startLine: scriptDeclLine } = extractScript(text);
    if (script && virtualPath) {
      const scriptContentActualStartLine = scriptDeclLine + 1;
      const scriptLines = script.split("\n");
      const scriptContentActualEndLine =
        scriptContentActualStartLine + scriptLines.length - 1;

      if (
        position.line >= scriptContentActualStartLine &&
        position.line <= scriptContentActualEndLine
      ) {
        const localPositionResult = getLocationInBlock(
          text,
          scriptDeclLine,
          scriptContentActualEndLine,
          INDENT_SIZE,
          {
            type: "line-column",
            line: position.line,
            column: position.character,
          },
          totalAdditionalPartChars,
        );
        if (localPositionResult) {
          const quickInfo = tsService.getQuickInfoAtPosition(
            virtualPath,
            localPositionResult.localPosition.offset,
          );
          if (quickInfo) {
            const displayString = ts.displayPartsToString(
              quickInfo.displayParts,
            );
            const docString = ts.displayPartsToString(quickInfo.documentation);
            // Map range back to original document
            const scriptTextDoc = TextDocument.create(
              virtualPath,
              "typescript",
              0,
              scriptContents.get(virtualPath)!,
            );
            const startPosInVirtual = scriptTextDoc.positionAt(
              quickInfo.textSpan.start,
            );
            const endPosInVirtual = scriptTextDoc.positionAt(
              quickInfo.textSpan.start + quickInfo.textSpan.length,
            );

            return {
              contents: {
                kind: "markdown",
                value: `**${displayString}**\n\n${docString}`,
              },
              range: Range.create(
                startPosInVirtual.line -
                  totalAdditionalPartLines +
                  scriptContentActualStartLine -
                  1,
                startPosInVirtual.character + INDENT_SIZE,
                endPosInVirtual.line -
                  totalAdditionalPartLines +
                  scriptContentActualStartLine -
                  1,
                endPosInVirtual.character + INDENT_SIZE,
              ),
            };
          }
        }
      }
    }
    return null;
  });

  connection.onDefinition((params: DefinitionParams): Location[] | null => {
    const uri = params.textDocument.uri;
    const doc = documents.get(uri);
    if (!doc) return null;

    const text = doc.getText();
    const position = params.position;
    let currentActiveVirtualFile = activeVirtualFile;

    if (!currentActiveVirtualFile) {
      setActiveFileFromUri(uri, (v) => (currentActiveVirtualFile = v));
      if (!currentActiveVirtualFile) return null;
      if (!scriptContents.has(currentActiveVirtualFile)) {
        // Ensure script content is loaded
        const {
          script: currentFileScript,
          startLine: currentFileScriptStartLine,
        } = extractScript(text);
        const currentFileInputs = extractInputs(text);
        const currentFileInputDeclarations =
          Object.entries(currentFileInputs)
            .map(([name, type]) => `declare let ${name}: ${type};`)
            .join("\n") + "\n";
        const updatedCurrentFileScript = `${currentFileInputDeclarations}${currentFileScript}`;
        scriptContents.set(currentActiveVirtualFile, updatedCurrentFileScript);
        scriptVersions.set(
          currentActiveVirtualFile,
          (scriptVersions.get(currentActiveVirtualFile) || 0) + 1,
        );
        totalAdditionalPartChars = currentFileInputDeclarations.length;
        totalAdditionalPartLines =
          currentFileInputDeclarations.split("\n").length - 1;
      }
    }
    const virtualPath = currentActiveVirtualFile;

    // HTML Block Definition
    const {
      html,
      startLine: hStart,
      endLine: hEnd,
      indent: htmlIndent,
    } = extractHTML(text);
    if (html && position.line >= hStart && position.line <= hEnd) {
      const htmlTextDoc = TextDocument.create(uri, "html", doc.version, html);
      const relPosInHtmlBlock = Position.create(
        position.line - hStart,
        position.character - htmlIndent,
      );
      const templateContext = getLunasTemplateContext(
        htmlTextDoc,
        relPosInHtmlBlock,
        htmlService,
      );

      if (templateContext && virtualPath) {
        const originalScriptContent = scriptContents.get(virtualPath);
        if (!originalScriptContent) return null;

        const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
        const nodeAtCursor = parsedHtmlDoc.findNodeAt(
          htmlTextDoc.offsetAt(relPosInHtmlBlock),
        );

        const { tempScript, expressionOffsetInTempScript } =
          prepareTemporaryScriptForExpression(
            originalScriptContent,
            templateContext.expression,
            nodeAtCursor,
            htmlTextDoc,
            htmlService,
          );
        const originalVersion = scriptVersions.get(virtualPath) || 0;
        scriptContents.set(virtualPath, tempScript);
        scriptVersions.set(virtualPath, originalVersion + 1);

        const definitions = tsService.getDefinitionAtPosition(
          virtualPath,
          expressionOffsetInTempScript + templateContext.offsetInExpression,
        );

        scriptContents.set(virtualPath, originalScriptContent);
        scriptVersions.set(virtualPath, originalVersion + 2);

        if (definitions) {
          const results: Location[] = [];
          const program = tsService.getProgram();
          if (!program) return null;

          for (const def of definitions) {
            const defSourceFile = program.getSourceFile(def.fileName);
            if (!defSourceFile) continue;

            const defStart = defSourceFile.getLineAndCharacterOfPosition(
              def.textSpan.start,
            );
            const defEnd = defSourceFile.getLineAndCharacterOfPosition(
              def.textSpan.start + def.textSpan.length,
            );

            if (def.fileName === virtualPath) {
              // Definition is in the same virtual script
              // Check if the definition is within the input declarations part
              if (def.textSpan.start < totalAdditionalPartChars) {
                // Definition is of an @Input. Ideally, link to the component tag or input declaration in source.
                // For now, we skip it or point to the start of the script block.
                continue;
              }
              results.push({
                uri: uri, // Original document URI
                range: Range.create(
                  defStart.line -
                    totalAdditionalPartLines +
                    (extractScript(text).startLine + 1) -
                    1,
                  defStart.character + INDENT_SIZE,
                  defEnd.line -
                    totalAdditionalPartLines +
                    (extractScript(text).startLine + 1) -
                    1,
                  defEnd.character + INDENT_SIZE,
                ),
              });
            } else {
              // Definition is in an external file (.d.ts or other .ts)
              results.push({
                uri: pathToFileURL(def.fileName).toString(),
                range: Range.create(defStart, defEnd),
              });
            }
          }
          return results;
        }
      }
    }

    // Script Block Definition
    const { script, startLine: scriptDeclLine } = extractScript(text);
    if (script && virtualPath) {
      const scriptContentActualStartLine = scriptDeclLine + 1;
      const scriptLines = script.split("\n");
      const scriptContentActualEndLine =
        scriptContentActualStartLine + scriptLines.length - 1;

      if (
        position.line >= scriptContentActualStartLine &&
        position.line <= scriptContentActualEndLine
      ) {
        const localPositionResult = getLocationInBlock(
          text,
          scriptDeclLine,
          scriptContentActualEndLine,
          INDENT_SIZE,
          {
            type: "line-column",
            line: position.line,
            column: position.character,
          },
          totalAdditionalPartChars,
        );
        if (localPositionResult) {
          const definitions = tsService.getDefinitionAtPosition(
            virtualPath,
            localPositionResult.localPosition.offset,
          );
          if (definitions) {
            const results: Location[] = [];
            const program = tsService.getProgram();
            if (!program) return null;

            for (const def of definitions) {
              const defSourceFile = program.getSourceFile(def.fileName);
              if (!defSourceFile) continue;
              const defStart = defSourceFile.getLineAndCharacterOfPosition(
                def.textSpan.start,
              );
              const defEnd = defSourceFile.getLineAndCharacterOfPosition(
                def.textSpan.start + def.textSpan.length,
              );

              if (def.fileName === virtualPath) {
                if (def.textSpan.start < totalAdditionalPartChars) continue; // Skip @Input defs
                results.push({
                  uri: uri,
                  range: Range.create(
                    defStart.line -
                      totalAdditionalPartLines +
                      scriptContentActualStartLine -
                      1,
                    defStart.character + INDENT_SIZE,
                    defEnd.line -
                      totalAdditionalPartLines +
                      scriptContentActualStartLine -
                      1,
                    defEnd.character + INDENT_SIZE,
                  ),
                });
              } else {
                results.push({
                  uri: pathToFileURL(def.fileName).toString(),
                  range: Range.create(defStart, defEnd),
                });
              }
            }
            return results;
          }
        }
      }
    }
    return null;
  });

  documents.listen(connection);
  connection.listen();
}

init().catch((err) => {
  console.error("LSP Server initialization failed:", err);
});
