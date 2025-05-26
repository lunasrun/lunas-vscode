import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  CompletionItemKind,
  InsertTextFormat,
  DiagnosticSeverity,
  TextEdit,
  Range,
  Position,
  // Explicitly import types used for clarity
  InitializeParams,
  CompletionParams,
  HoverParams,
  DefinitionParams,
  CompletionItem,
  Hover,
  Location,
  Diagnostic,
} from "vscode-languageserver/node";
import * as fs from "fs";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import * as path from "path";
import { pathToFileURL } from "url";
import { getLocationInBlock } from "./utils/text-location";
import {
  getLanguageService as getHTMLLanguageService,
  Node, // Import Node type from html language service
} from "vscode-html-languageservice/lib/esm/htmlLanguageService";
import { getCSSLanguageService } from "vscode-css-languageservice/lib/esm/cssLanguageService";
import {
  extractScript,
  extractInputs,
  extractHTML,
  extractStyle,
  findAndReadTSConfig,
  getVirtualFilePath,
  setActiveFileFromUri,
} from "./utils/lunas-blocks";

const scriptContents = new Map<string, string>();
const scriptVersions = new Map<string, number>();
const tsConfigCache = new Map<string, ts.ParsedCommandLine>();
let activeVirtualFile: string | null = null;

// (mapTsCompletionKind function remains the same as your provided code)
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
      return CompletionItemKind.TypeParameter;
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return CompletionItemKind.Module;
    case ts.ScriptElementKind.classElement:
    case ts.ScriptElementKind.typeElement:
      return CompletionItemKind.Class;
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
    // Corrected: memberVariableElement was listed twice. Assuming Property was intended.
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Property;
    case ts.ScriptElementKind.constructorImplementationElement:
      return CompletionItemKind.Constructor;
    case ts.ScriptElementKind.string:
      return CompletionItemKind.Text;
    default:
      return CompletionItemKind.Text;
  }
}

async function init() {
  const connection = createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments(
    TextDocument,
  );
  const htmlService = getHTMLLanguageService({});
  const cssService = getCSSLanguageService({});
  const INDENT_SIZE = 2;
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
          triggerCharacters: [
            "<",
            "/",
            " ",
            ".",
            '"',
            "'",
            "`",
            "$",
            "{",
            ":",
            "@",
          ],
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
        : {
            ...ts.getDefaultCompilerOptions(),
            jsx: ts.JsxEmit.Preserve,
            allowJs: true,
          }; // allowJs might be useful
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
    resolveModuleNames: (moduleNames, containingFile) => {
      const resolvedModules: ts.ResolvedModule[] = [];
      const compilerOptions = tsHost.getCompilationSettings();
      for (const moduleName of moduleNames) {
        const result = ts.resolveModuleName(
          moduleName,
          containingFile,
          compilerOptions,
          { fileExists: tsHost.fileExists, readFile: tsHost.readFile },
        );
        if (result.resolvedModule) {
          resolvedModules.push(result.resolvedModule);
        }
      }
      return resolvedModules;
    },
  };

  const tsService = ts.createLanguageService(tsHost);

  /**
   * Parses a :for attribute value string.
   * Examples:
   * "[index, player] of sortedPlayers().entries()" -> { variables: "[index, player]", isDestructuring: true, iterable: "sortedPlayers().entries()", operator: "of" }
   * "item of getItems()" -> { variables: "item", isDestructuring: false, iterable: "getItems()", operator: "of" }
   * "key in object" -> { variables: "key", isDestructuring: false, iterable: "object", operator: "in" }
   * "let [k, v] of collection" -> { variables: "[k,v]", keyword: "let", ... }
   */
  function parseForExpression(expression: string): {
    keyword?: "let" | "const" | "var";
    variables: string;
    isDestructuring: boolean;
    operator: "of" | "in";
    iterable: string;
  } | null {
    const ofMatch = expression.match(
      /^(let|const|var)?\s*([\[\]\w\s,{}:]+?)\s+of\s+(.+)$/i,
    );
    if (ofMatch) {
      const keyword = ofMatch[1] as "let" | "const" | "var" | undefined;
      const variables = ofMatch[2].trim();
      return {
        keyword,
        variables,
        isDestructuring: variables.startsWith("[") || variables.startsWith("{"),
        operator: "of",
        iterable: ofMatch[3].trim(),
      };
    }
    const inMatch = expression.match(
      /^(let|const|var)?\s*(\w+?)\s+in\s+(.+)$/i,
    );
    if (inMatch) {
      const keyword = inMatch[1] as "let" | "const" | "var" | undefined;
      const variables = inMatch[2].trim();
      return {
        keyword,
        variables,
        isDestructuring: false, // "in" operator typically doesn't use destructuring for the key
        operator: "in",
        iterable: inMatch[3].trim(),
      };
    }
    return null;
  }

  function prepareTemporaryScriptForExpression(
    originalScriptContent: string,
    expression: string,
    htmlNodeForScope: Node | undefined, // Can be undefined if not in a node context
    htmlDoc: TextDocument, // The HTML part as a TextDocument
    htmlServiceInstance: ReturnType<typeof getHTMLLanguageService>, // Pass the instance
    attributeName?: string, // To know if it's a :for or other attribute
    expressionWithinAttributeValue?: string, // The specific part of expression being analyzed if inside a complex attr
  ): {
    tempScript: string;
    expressionOffsetInTempScript: number;
    forVars: { name: string; type: string }[];
  } {
    let prefix = originalScriptContent + "\n;(() => {\n";
    const forVars: { name: string; type: string }[] = []; // To store variables declared by :for

    // Track for scopes for ancestor :for loops
    const forScopes: {
      keyword?: "let" | "const" | "var";
      variables: string;
      isDestructuring: boolean;
      operator: "of" | "in";
      iterable: string;
    }[] = [];

    // Start traversal from the element node itself for interpolations,
    // but skip the current node for direct :for attribute analysis
    const currentHtmlNodeStart =
      attributeName === ":for" ? htmlNodeForScope?.parent : htmlNodeForScope;
    let currentHtmlNode = currentHtmlNodeStart;
    const visitedNodes = new Set<Node>(); // Prevent infinite loops

    while (currentHtmlNode && !visitedNodes.has(currentHtmlNode)) {
      visitedNodes.add(currentHtmlNode);
      const forAttributeValue = currentHtmlNode.attributes?.[":for"];
      // Inject manual : any variable declarations for every :for, including the one being analyzed
      if (forAttributeValue) {
        const parsedFor = parseForExpression(forAttributeValue.slice(1, -1)); // remove quotes
        if (parsedFor) {
          // Declare loop variables in the temporary script for type checking context
          // This is a simplified declaration; actual type inference from iterable is complex.
          const declarationKeyword = parsedFor.keyword || "let"; // Default to 'let'
          prefix += `  ${declarationKeyword} ${parsedFor.variables}: any;\n`; // Use 'any' for now, TS will infer if possible from the loop below
          if (parsedFor.isDestructuring) {
            // Crude way to get individual var names from destructuring string
            parsedFor.variables
              .replace(/[\[\]\{\}\s,:]+/g, " ")
              .trim()
              .split(" ")
              .forEach((v) => {
                if (v) forVars.push({ name: v, type: "any" });
              });
          } else {
            forVars.push({ name: parsedFor.variables, type: "any" });
          }
          forScopes.push(parsedFor);
        }
      }
      currentHtmlNode = currentHtmlNode.parent;
    }

    // Insert debug log after ancestor traversal
    console.log("DEBUG prefix for TS context:", prefix);

    // If inside an ancestor :for, but not the :for attribute itself, wrap nested loops for inference
    if (forScopes.length > 0 && attributeName !== ":for") {
      let snippet = "";
      forScopes.forEach((scope, idx) => {
        const loopKeyword = scope.keyword || "let";
        snippet += `${loopKeyword} __iterable${idx} = ${scope.iterable};
for (${loopKeyword} ${scope.variables} ${scope.operator} __iterable${idx}) {\n`;
      });
      const innerExpr = expressionWithinAttributeValue || expression;
      snippet += `  return (${innerExpr});\n`;
      for (let i = 0; i < forScopes.length; i++) {
        snippet += `}\n`;
      }
      const tempScript = prefix + snippet + "})();\n";
      const exprIdx = snippet.lastIndexOf(innerExpr);
      const expressionOffsetInTempScript = prefix.length + exprIdx;
      return { tempScript, expressionOffsetInTempScript, forVars };
    }

    if (attributeName === ":for") {
      const parsedFor = parseForExpression(expression);
      if (parsedFor) {
        const loopKeyword = parsedFor.keyword || "let";
        // Construct a for-of loop to let TS infer types of the loop variables
        const forLoop = `${loopKeyword} __iterable = ${parsedFor.iterable};
for (${loopKeyword} ${parsedFor.variables} ${parsedFor.operator} __iterable) {
  ${expressionWithinAttributeValue}
}
return ${expressionWithinAttributeValue};`;
        // Insert debug log for for-of snippet
        console.log("DEBUG for-of snippet:", forLoop);
        const tempScript = prefix + forLoop + "\n})();\n";
        // Compute offset to the start of the expressionWithinAttributeValue in forLoop
        const iterableIndex = forLoop.lastIndexOf(
          expressionWithinAttributeValue ?? "",
        );
        const expressionOffsetInTempScript = prefix.length + iterableIndex;
        // Collect variables declared by the loop for later use
        const forVars: { name: string; type: string }[] = [];
        if (parsedFor.isDestructuring) {
          parsedFor.variables
            .replace(/[\[\]\{\}\s,:]+/g, " ")
            .trim()
            .split(" ")
            .forEach((v) => {
              if (v) forVars.push({ name: v, type: "any" });
            });
        } else {
          forVars.push({ name: parsedFor.variables, type: "any" });
        }
        return { tempScript, expressionOffsetInTempScript, forVars };
      }
    }

    const expressionToUse = expressionWithinAttributeValue || expression;
    let tempScript: string;
    let expressionOffsetInTempScript: number;

    // If not handled above (i.e., not :for or :for parse failed), fall back to regular return expression
    tempScript = prefix + "return (" + expressionToUse + ");\n})();\n";
    expressionOffsetInTempScript = prefix.length + "return (".length;
    return { tempScript, expressionOffsetInTempScript, forVars };
  }

  documents.onDidChangeContent(async (change) => {
    // Make async for potential async operations
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
    const scriptBlockStartLine = startLine + 1;
    const diagnostics: Diagnostic[] = [];

    // Ensure TS program is up-to-date
    tsService.getProgram();

    // Script block diagnostics
    const syntaxDiagnostics = tsService.getSyntacticDiagnostics(virtualPath);
    const semanticDiagnostics = tsService.getSemanticDiagnostics(virtualPath);
    [...syntaxDiagnostics, ...semanticDiagnostics].forEach((tsDiag) => {
      if (
        tsDiag.file &&
        tsDiag.start !== undefined &&
        tsDiag.file.fileName === virtualPath
      ) {
        if (tsDiag.start < totalAdditionalPartChars) return; // Skip errors from injected inputs
        const diagStartPos = tsDiag.file.getLineAndCharacterOfPosition(
          tsDiag.start,
        );
        const diagEndPos = tsDiag.file.getLineAndCharacterOfPosition(
          tsDiag.start + (tsDiag.length || 0),
        );
        diagnostics.push({
          severity:
            tsDiag.category === ts.DiagnosticCategory.Error
              ? DiagnosticSeverity.Error
              : tsDiag.category === ts.DiagnosticCategory.Warning
                ? DiagnosticSeverity.Warning
                : tsDiag.category === ts.DiagnosticCategory.Suggestion
                  ? DiagnosticSeverity.Hint
                  : DiagnosticSeverity.Information,
          range: {
            start: {
              line:
                diagStartPos.line -
                totalAdditionalPartLines +
                scriptBlockStartLine -
                1,
              character: diagStartPos.character + INDENT_SIZE,
            },
            end: {
              line:
                diagEndPos.line -
                totalAdditionalPartLines +
                scriptBlockStartLine -
                1,
              character: diagEndPos.character + INDENT_SIZE,
            },
          },
          message: ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n"),
          source: "Lunas TS",
          code: tsDiag.code,
        });
      }
    });

    // HTML Template Diagnostics
    const { html, startLine: hStart, indent: htmlIndent } = extractHTML(text);
    if (html && virtualPath && scriptContents.has(virtualPath)) {
      const htmlDoc = TextDocument.create(
        `${uri}__html_template__`,
        "html",
        change.document.version,
        html,
      );
      const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlDoc);
      const originalScriptContent = scriptContents.get(virtualPath)!; // Should exist

      function traverseHtmlNodesForDiagnostics(node: Node) {
        if (node.attributes) {
          for (const attrName in node.attributes) {
            // Check attributes like :prop, @event, :for, :if
            if (attrName.startsWith(":") || attrName.startsWith("@")) {
              const attributeValueWithQuotes = node.attributes[attrName];
              if (!attributeValueWithQuotes) continue;
              const attributeValue = attributeValueWithQuotes.slice(1, -1); // Remove quotes

              // Determine the exact start of the expression within the attribute value in the HTML block
              const nodeText = html.substring(
                node.start,
                node.startTagEnd ?? node.end,
              );
              const attrFullString = `${attrName}=${attributeValueWithQuotes}`;
              const attrStartInNodeText = nodeText.indexOf(attrFullString);
              if (attrStartInNodeText === -1) continue;
              const expressionStartInNodeText =
                attrStartInNodeText + attrName.length + 2; // Past ="
              const expressionStartOffsetInHtmlBlock =
                node.start + expressionStartInNodeText;

              // Special handling for :for to analyze the iterable part
              let expressionToAnalyze = attributeValue;
              let subExpressionOffsetWithinAttrValue = 0;

              if (attrName === ":for") {
                const parsedFor = parseForExpression(attributeValue);
                if (parsedFor) {
                  expressionToAnalyze = parsedFor.iterable;
                  subExpressionOffsetWithinAttrValue =
                    attributeValue.lastIndexOf(parsedFor.iterable);
                  // If parsing failed or iterable is empty, skip TS check for it
                  if (
                    subExpressionOffsetWithinAttrValue === -1 ||
                    !parsedFor.iterable
                  )
                    continue;
                } else {
                  continue; // Invalid :for syntax, skip TS check for now
                }
              }

              const { tempScript, expressionOffsetInTempScript } =
                prepareTemporaryScriptForExpression(
                  originalScriptContent,
                  attributeValue, // Pass the full attribute value for context to prepareTemporaryScript
                  node,
                  htmlDoc,
                  htmlService,
                  attrName,
                  expressionToAnalyze, // Pass the specific part (e.g., iterable)
                );

              const originalVersion = scriptVersions.get(virtualPath)!;
              scriptContents.set(virtualPath, tempScript);
              scriptVersions.set(virtualPath, originalVersion + 1);

              // Analyze the specific part (e.g., iterable in :for)
              // The offset for diagnostics needs to be within this `expressionToAnalyze`
              // which is placed inside the `return (...)` in `tempScript`.
              const analysisTargetOffset =
                expressionOffsetInTempScript +
                (expressionToAnalyze.length > 0 ? 0 : -1); // Start of the expressionToAnalyze
              // The ts.getSyntacticDiagnostics / getSemanticDiagnostics takes the filename, not specific offset

              const templateTsDiagnostics = [
                ...tsService.getSyntacticDiagnostics(virtualPath),
                ...tsService.getSemanticDiagnostics(virtualPath),
              ].filter((diag) => diag.code !== 1182);

              scriptContents.set(virtualPath, originalScriptContent);
              scriptVersions.set(virtualPath, originalVersion + 2);

              templateTsDiagnostics.forEach((tsDiag) => {
                if (
                  tsDiag.file &&
                  tsDiag.start !== undefined &&
                  tsDiag.file.fileName === virtualPath
                ) {
                  // Check if the diagnostic is within the analyzed expression part of the temp script
                  const returnStatementStart =
                    tempScript.indexOf("return (") + "return (".length;
                  const returnStatementEnd = tempScript.lastIndexOf(");");
                  if (
                    tsDiag.start >= returnStatementStart &&
                    tsDiag.start + (tsDiag.length || 0) <= returnStatementEnd
                  ) {
                    const relativeErrorStartInExpression =
                      tsDiag.start - returnStatementStart;
                    const relativeErrorEndInExpression =
                      relativeErrorStartInExpression + (tsDiag.length || 0);

                    // Map this relative position back to the original HTML attribute value
                    const errorStartOffsetInHtmlAttr =
                      expressionStartOffsetInHtmlBlock +
                      subExpressionOffsetWithinAttrValue +
                      relativeErrorStartInExpression;
                    const errorEndOffsetInHtmlAttr =
                      expressionStartOffsetInHtmlBlock +
                      subExpressionOffsetWithinAttrValue +
                      relativeErrorEndInExpression;

                    const diagStartPosInHtml = htmlDoc.positionAt(
                      errorStartOffsetInHtmlAttr,
                    );
                    const diagEndPosInHtml = htmlDoc.positionAt(
                      errorEndOffsetInHtmlAttr,
                    );

                    diagnostics.push({
                      severity:
                        tsDiag.category === ts.DiagnosticCategory.Error
                          ? DiagnosticSeverity.Error
                          : tsDiag.category === ts.DiagnosticCategory.Warning
                            ? DiagnosticSeverity.Warning
                            : DiagnosticSeverity.Information,
                      range: {
                        start: {
                          line: hStart + diagStartPosInHtml.line,
                          character: htmlIndent + diagStartPosInHtml.character,
                        },
                        end: {
                          line: hStart + diagEndPosInHtml.line,
                          character: htmlIndent + diagEndPosInHtml.character,
                        },
                      },
                      message: ts.flattenDiagnosticMessageText(
                        tsDiag.messageText,
                        "\n",
                      ),
                      source: "Lunas Template TS",
                      code: tsDiag.code,
                    });
                  }
                }
              });
            }
          }
        }

        // Check interpolations: ${expression}
        // Check for text nodes (nodeType === 3)
        // html-languageservice Node does not have nodeType, so check for text node by tag === undefined
        if (node.tag === undefined) {
          // Text node
          const textContent = html.substring(node.start, node.end);
          const interpolationRegex = /\$\{([^}]*)\}/g;
          let match;
          while ((match = interpolationRegex.exec(textContent)) !== null) {
            const expression = match[1];
            if (!expression.trim()) continue;

            const expressionStartInTextNode = match.index + 2;
            const expressionOffsetInHtmlBlock =
              node.start + expressionStartInTextNode;

            const { tempScript, expressionOffsetInTempScript } =
              prepareTemporaryScriptForExpression(
                originalScriptContent,
                expression,
                node.parent,
                htmlDoc,
                htmlService,
              );

            const originalVersion = scriptVersions.get(virtualPath)!;
            scriptContents.set(virtualPath, tempScript);
            scriptVersions.set(virtualPath, originalVersion + 1);

            const templateTsDiagnostics = [
              ...tsService.getSyntacticDiagnostics(virtualPath),
              ...tsService.getSemanticDiagnostics(virtualPath),
            ].filter((diag) => diag.code !== 1182);
            scriptContents.set(virtualPath, originalScriptContent);
            scriptVersions.set(virtualPath, originalVersion + 2);

            templateTsDiagnostics.forEach((tsDiag) => {
              if (
                tsDiag.file &&
                tsDiag.start !== undefined &&
                tsDiag.file.fileName === virtualPath
              ) {
                const returnStatementStart =
                  tempScript.indexOf("return (") + "return (".length;
                const returnStatementEnd = tempScript.lastIndexOf(");");
                if (
                  tsDiag.start >= returnStatementStart &&
                  tsDiag.start + (tsDiag.length || 0) <= returnStatementEnd
                ) {
                  const relativeErrorStartInExpression =
                    tsDiag.start - returnStatementStart;
                  const relativeErrorEndInExpression =
                    relativeErrorStartInExpression + (tsDiag.length || 0);

                  const errorStartOffsetInHtml =
                    expressionOffsetInHtmlBlock +
                    relativeErrorStartInExpression;
                  const errorEndOffsetInHtml =
                    expressionOffsetInHtmlBlock + relativeErrorEndInExpression;

                  const diagStartPosInHtml = htmlDoc.positionAt(
                    errorStartOffsetInHtml,
                  );
                  const diagEndPosInHtml =
                    htmlDoc.positionAt(errorEndOffsetInHtml);
                  diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                      start: {
                        line: hStart + diagStartPosInHtml.line,
                        character: htmlIndent + diagStartPosInHtml.character,
                      },
                      end: {
                        line: hStart + diagEndPosInHtml.line,
                        character: htmlIndent + diagEndPosInHtml.character,
                      },
                    },
                    message: ts.flattenDiagnosticMessageText(
                      tsDiag.messageText,
                      "\n",
                    ),
                    source: "Lunas Template TS",
                    code: tsDiag.code,
                  });
                }
              }
            });
          }
        }

        if (node.children) {
          node.children.forEach(traverseHtmlNodesForDiagnostics);
        }
      }
      parsedHtmlDoc.roots.forEach(traverseHtmlNodesForDiagnostics);
    }

    connection.sendDiagnostics({ uri, diagnostics });
  });

  documents.onDidClose((change) => {
    const virtualPath = getVirtualFilePath(change.document.uri);
    scriptContents.delete(virtualPath);
    scriptVersions.delete(virtualPath);
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
        if (attrName.startsWith(":") || attrName.startsWith("@")) {
          const attrValueWithQuotes = nodeAtCursor.attributes[attrName];
          if (attrValueWithQuotes === null || attrValueWithQuotes === undefined)
            continue;

          const attrValue = attrValueWithQuotes.slice(1, -1); // Remove quotes

          // Calculate the start/end of the attribute value within the HTML block
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
            if (attrName === ":for") {
              const parsedFor = parseForExpression(attrValue);
              if (!parsedFor) {
                continue;
              }
              const iterable = parsedFor.iterable;
              // Calculate offsets within the attribute
              const iterableStartInAttr = attrValue.indexOf(iterable);
              const cursorOffsetInAttr =
                offsetInHtmlBlock - expressionStartInHtmlBlockOffset;
              // Case 1: Cursor in iterable expression
              if (cursorOffsetInAttr >= iterableStartInAttr) {
                return {
                  expression: iterable,
                  offsetInExpression: cursorOffsetInAttr - iterableStartInAttr,
                  expressionStartInHtmlBlock: htmlTextDoc.positionAt(
                    expressionStartInHtmlBlockOffset + iterableStartInAttr,
                  ),
                  type: "attribute",
                  attributeName: attrName,
                };
              }
              // Case 2: Cursor in loop variable declaration
              if (parsedFor.isDestructuring) {
                // Handle destructured variables individually
                const destructStart = attrValue.indexOf(parsedFor.variables);
                const inner = parsedFor.variables.slice(1, -1); // remove [ ]
                const varsArray = inner.split(",").map((v) => v.trim());
                for (const varName of varsArray) {
                  const varOffset = parsedFor.variables.indexOf(varName);
                  const startInAttr = destructStart + varOffset;
                  if (
                    cursorOffsetInAttr >= startInAttr &&
                    cursorOffsetInAttr < startInAttr + varName.length
                  ) {
                    return {
                      expression: varName,
                      offsetInExpression: cursorOffsetInAttr - startInAttr,
                      expressionStartInHtmlBlock: htmlTextDoc.positionAt(
                        expressionStartInHtmlBlockOffset + startInAttr,
                      ),
                      type: "attribute",
                      attributeName: attrName,
                    };
                  }
                }
              } else {
                // Single variable case
                const varName = parsedFor.variables;
                const varStart = attrValue.indexOf(varName);
                if (
                  cursorOffsetInAttr >= varStart &&
                  cursorOffsetInAttr < varStart + varName.length
                ) {
                  return {
                    expression: varName,
                    offsetInExpression: cursorOffsetInAttr - varStart,
                    expressionStartInHtmlBlock: htmlTextDoc.positionAt(
                      expressionStartInHtmlBlockOffset + varStart,
                    ),
                    type: "attribute",
                    attributeName: attrName,
                  };
                }
              }
              continue; // Otherwise, skip TS support
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
            };
          }
        }
      }
    }
    return null;
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
              nodeAtCursor,
              htmlTextDoc,
              htmlService,
              templateContext.attributeName,
              templateContext.expression,
            );

          const originalVersion = scriptVersions.get(virtualPath) || 0;
          scriptContents.set(virtualPath, tempScript);
          scriptVersions.set(virtualPath, originalVersion + 1);
          const program = tsService.getProgram();

          // DEBUG: Try-catch with logs for tsService.getCompletionsAtPosition
          let tsCompletions;
          try {
            tsCompletions = tsService.getCompletionsAtPosition(
              virtualPath,
              expressionOffsetInTempScript + templateContext.offsetInExpression,
              {},
            );
          } catch (err) {
            console.error(
              "ERROR tsService.getCompletionsAtPosition failed:",
              err,
            );
          }

          // Restore original script
          scriptContents.set(virtualPath, originalScriptContent);
          scriptVersions.set(virtualPath, originalVersion + 2); // Increment version again

          if (tsCompletions) {
            return tsCompletions.entries.map((entry) => {
              return {
                label: entry.name,
                kind: mapTsCompletionKind(entry.kind),
                insertText: entry.name,
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
