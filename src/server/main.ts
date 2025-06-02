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

// --- Lunas template block parsing definitions ---
type BlkNode = IfBlk | ForBlk | Expr;

interface IfBlk {
  type: "if";
  cond: string;
  originalPos: [number, number];
  startOffset: number;
  children: BlkNode[];
}

interface ForBlk {
  type: "for";
  forCond: {
    cond: string;
    isDeclOmitted: boolean;
  };
  originalPos: [number, number];
  startOffset: number;
  children: BlkNode[];
}

interface Expr {
  type: "expr";
  originalPos: [number, number];
  startOffset: number;
  value: string;
}

/**
 * Parse HTML template into a list of nested BlkNode objects:
 * top-level Expr nodes and ForBlk/IfBlk nodes containing their child Exprs.
 */
function parseTemplateBlocks(
  htmlDoc: TextDocument,
  htmlServiceInstance: ReturnType<typeof getHTMLLanguageService>,
): BlkNode[] {
  const html = htmlDoc.getText();

  // Compute ranges of all HTML comments to filter out interpolation inside them
  const commentRanges: { start: number; end: number }[] = [];
  const commentRegex = /<!--[\s\S]*?-->/g;
  let commentMatch: RegExpExecArray | null;
  while ((commentMatch = commentRegex.exec(html))) {
    commentRanges.push({ start: commentMatch.index, end: commentMatch.index + commentMatch[0].length });
  }

  // 1. Collect all interpolation expressions
  const exprMatches: {
    value: string;
    startOffset: number;
    endOffset: number;
    originalPos: [number, number];
  }[] = [];
  const interpRegex = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = interpRegex.exec(html))) {
    const exprGlobalStart = match.index;
    // skip if inside any comment
    if (commentRanges.some(r => exprGlobalStart >= r.start && exprGlobalStart < r.end)) {
      continue;
    }
    // Trim expression and adjust offsets to trimmed region
    const raw = match[1];
    const exprStartOffset = match.index + 2;
    const rawTrimmed = raw.trim();
    const leadingSpaces = raw.indexOf(rawTrimmed);
    const trimmedStartOffset = exprStartOffset + leadingSpaces;
    const trimmedEndOffset = trimmedStartOffset + rawTrimmed.length;
    const pos = htmlDoc.positionAt(trimmedStartOffset);
    exprMatches.push({
      value: rawTrimmed,
      startOffset: trimmedStartOffset,
      endOffset: trimmedEndOffset,
      originalPos: [pos.line, pos.character], // row/column of the first expression character
    });
  }

  // 1.a. Collect attribute-binding expressions (e.g. @click="...", :if="...", ::bind="...")
  // Move parseHTMLDocument here so it's not used before declaration
  const parsed = htmlServiceInstance.parseHTMLDocument(htmlDoc);
  const attrRegex = /^[:"@]/; // matches attributes starting with ':' or '@'
  parsed.roots.forEach(function collectAttrExprs(node: Node) {
    if (node.attributes) {
      for (const [attrName, raw] of Object.entries(node.attributes)) {
        if (raw == null) continue;
        if (
          (attrName.startsWith(":") || attrName.startsWith("@")) &&
          attrName !== ":for" &&
          attrName !== ":if"
        ) {
          const rawExpr = raw.slice(1, -1);
          const rawTrimmed = rawExpr.trim();
          const leadingSpaces = rawExpr.indexOf(rawTrimmed);
          const valueStartOffset =
            html.indexOf(raw, node.start) + 1 + leadingSpaces;
          const valueEndOffset = valueStartOffset + rawTrimmed.length;
          const pos = htmlDoc.positionAt(valueStartOffset);
          exprMatches.push({
            value: rawTrimmed,
            startOffset: valueStartOffset,
            endOffset: valueEndOffset,
            originalPos: [pos.line, pos.character],
          });
        }
      }
    }
    if (node.children) {
      node.children.forEach(collectAttrExprs);
    }
  });

  // 2. Find all :for and :if blocks with their offset ranges
  type BlockRange = {
    block: ForBlk | IfBlk;
    startOffset: number;
    endOffset: number;
  };
  const blockRanges: BlockRange[] = [];

  function findBlocks(node: Node) {
    if (node.attributes) {
      if (node.attributes[":for"]) {
        const raw = node.attributes[":for"]!;
        const inner = raw.slice(1, -1).trim();
        const isDeclOmitted = !/^(?:let|const|var)\s+/.test(inner);
        const cond = isDeclOmitted ? `let ${inner}` : inner;
        const startOffset = node.start!;
        const endOffset = node.end!;
        // Compute the start of the condition expression for originalPos
        const rawFor = node.attributes[":for"]!;
        const valueStartOffset = html.indexOf(rawFor, node.start!) + 1;
        const pos = htmlDoc.positionAt(valueStartOffset);
        const block: ForBlk = {
          type: "for",
          forCond: { cond, isDeclOmitted },
          originalPos: [pos.line, pos.character],
          startOffset,
          children: [],
        };
        blockRanges.push({ block, startOffset, endOffset });
      }
      if (node.attributes[":if"]) {
        // Compute the start of the condition expression for originalPos
        const rawCond = node.attributes[":if"]!;
        const valueStartOffset = html.indexOf(rawCond, node.start!) + 1;
        const pos = htmlDoc.positionAt(valueStartOffset);
        const cond = rawCond.slice(1, -1).trim();
        const startOffset = node.start!;
        const endOffset = node.end!;
        const block: IfBlk = {
          type: "if",
          cond: cond,
          originalPos: [pos.line, pos.character],
          startOffset,
          children: [],
        };
        blockRanges.push({ block, startOffset, endOffset });
      }
    }
    if (node.children) {
      node.children.forEach(findBlocks);
    }
  }
  parsed.roots.forEach(findBlocks);

  // If a node has both :for and :if attributes, nest the IfBlk inside the ForBlk
  for (let i = blockRanges.length - 1; i >= 0; i--) {
    const br = blockRanges[i];
    if (br.block.type === "if") {
      const matchingForIndex = blockRanges.findIndex(
        (other) =>
          other !== br &&
          other.block.type === "for" &&
          other.startOffset === br.startOffset &&
          other.endOffset === br.endOffset,
      );
      if (matchingForIndex !== -1) {
        // Move this IfBlk into the matching ForBlk's children
        (blockRanges[matchingForIndex].block as ForBlk).children.push(
          br.block as IfBlk,
        );
        // Remove this IfBlk from top-level
        blockRanges.splice(i, 1);
      }
    }
  }

  // 3. Build a hierarchical block tree
  // Establish parent-child links between blocks
  blockRanges.forEach((br) => {
    const { block, startOffset, endOffset } = br;
    // Only consider p as parent if its range strictly contains br's range
    const parents = blockRanges.filter((p) => {
      if (p === br) return false;
      // only consider p as parent if its range strictly contains br's range
      return p.startOffset < startOffset && p.endOffset > endOffset;
    });
    if (parents.length > 0) {
      // pick the innermost parent
      const innermost = parents.reduce((a, b) =>
        a.endOffset - a.startOffset <= b.endOffset - b.startOffset ? a : b,
      );
      innermost.block.children.push(block);
    }
  });

  // Collect root-level blocks
  const rootBlocks: BlkNode[] = blockRanges
    .filter(
      (br) =>
        !blockRanges.some(
          (p) =>
            p !== br &&
            p.startOffset < br.startOffset &&
            p.endOffset > br.endOffset,
        ),
    )
    .map((br) => br.block);

  // Assign expressions to their innermost block, or to top-level if none
  const topLevelExprs: Expr[] = [];
  exprMatches.forEach((em) => {
    const exprNode: Expr = {
      type: "expr",
      originalPos: em.originalPos,
      startOffset: em.startOffset,
      value: em.value,
    };
    const containing = blockRanges.filter(
      (br) => em.startOffset >= br.startOffset && em.endOffset <= br.endOffset,
    );
    if (containing.length > 0) {
      const innermost = containing.reduce((a, b) =>
        a.endOffset - a.startOffset <= b.endOffset - b.startOffset ? a : b,
      );
      innermost.block.children.push(exprNode);
    } else {
      topLevelExprs.push(exprNode);
    }
  });

  // Sort each block's children by original HTML position
  function sortChildren(nodes: BlkNode[]) {
    nodes.sort((a, b) => a.startOffset - b.startOffset);
    nodes.forEach((n) => {
      if (n.type === "if" || n.type === "for") {
        sortChildren(n.children);
      }
    });
  }
  sortChildren(rootBlocks);

  // 4. Build result: merge and sort by original offset to preserve HTML order
  const result: BlkNode[] = [...topLevelExprs, ...rootBlocks];
  result.sort((a, b) => a.startOffset - b.startOffset);
  return result;
}

/**
 * Generate a virtual TS snippet and mapping info from a list of BlkNode.
 */
function generateVirtualTsFromBlks(
  blks: BlkNode[],
  originalScriptContent: string,
): {
  tempScript: string;
  mappings: {
    value: string;
    originalPos: [number, number];
    tsPos: [number, number];
  }[];
} {
  const lines: string[] = [];
  const mappings: {
    value: string;
    originalPos: [number, number];
    tsPos: [number, number];
  }[] = [];
  const prefixOffset = originalScriptContent.length + 1;
  let cursor = prefixOffset;

  function emit(nodes: BlkNode[]) {
    nodes.forEach((n) => {
      if (n.type === "if") {
        const header = `if (${n.cond}) {`;
        // Compute mapping for the condition expression within the header
        const condStartInHeader = header.indexOf(n.cond);
        const tsCondStart = cursor + condStartInHeader;
        const tsCondEnd = tsCondStart + n.cond.length;
        mappings.push({
          value: n.cond,
          originalPos: n.originalPos,
          tsPos: [tsCondStart, tsCondEnd],
        });
        lines.push(header);
        cursor += header.length + 1;
        emit(n.children);
        const footer = `}`;
        lines.push(footer);
        cursor += footer.length + 1;
      } else if (n.type === "for") {
        const header = `for (${n.forCond.cond}) {`;
        // Compute mapping for the for-loop condition expression within the header
        const condStartInHeader = header.indexOf(n.forCond.cond);
        const tsCondStart = cursor + condStartInHeader;
        const tsCondEnd = tsCondStart + n.forCond.cond.length;
        mappings.push({
          value: n.forCond.cond,
          originalPos: n.originalPos,
          tsPos: [tsCondStart, tsCondEnd],
        });
        lines.push(header);
        cursor += header.length + 1;
        emit(n.children);
        const footer = `}`;
        lines.push(footer);
        cursor += footer.length + 1;
      } else if (n.type === "expr") {
        const [startLine, startChar] = n.originalPos;
        const line = `  (${n.value});`;
        // Compute TS offsets using cursor and position within line
        const tsStart = cursor + line.indexOf(n.value);
        const tsEnd = tsStart + n.value.length;
        mappings.push({
          value: n.value,
          originalPos: n.originalPos,
          tsPos: [tsStart, tsEnd],
        });
        lines.push(line);
        // Advance cursor by line length + newline
        cursor += line.length + 1;
      }
    });
  }

  emit(blks);
  const snippet = lines.join("\n");
  const tempScript = originalScriptContent + "\n" + snippet + "\n";
  return { tempScript, mappings };
}

console.log("[Lunas Debug] LSP Server starting...");

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
   * Simplified :for parser: only detects if a keyword is present.
   * Returns the original expression and the detected keyword (if any).
   */
  function parseForExpression(expression: string): {
    keyword: string;
    raw: string;
  } {
    const match = expression.match(/^(?:\s*(let|const|var)\s+)?([\s\S]+)$/);
    if (!match) {
      // No match means treat entire expression as raw
      return { keyword: "", raw: expression.trim() };
    }
    return {
      keyword: match[1] || "",
      raw: match[2].trim(),
    };
  }

  function prepareTemporaryScriptForExpression(
    originalScriptContent: string,
    expression: string,
    htmlNodeForScope: Node | undefined,
    htmlDoc: TextDocument,
    htmlServiceInstance: ReturnType<typeof getHTMLLanguageService>,
    attributeName?: string,
    expressionWithinAttributeValue?: string,
  ): {
    tempScript: string;
    expressionOffsetInTempScript: number;
    forVars: { name: string; type: string }[];
    blockMappings: {
      value: string;
      originalPos: [number, number];
      tsPos: [number, number];
    }[];
  } {
    console.log(
      "[Lunas Debug] prepareTemporaryScriptForExpression called with expression:",
      expression,
    );
    const blks = parseTemplateBlocks(htmlDoc, htmlServiceInstance);
    console.log("[Lunas Debug] Parsed blocks:", blks);
    const { tempScript: blockScript, mappings: blockMappings } =
      generateVirtualTsFromBlks(blks, originalScriptContent);
    console.log("[Lunas Debug] Generated block-based tempScript:", blockScript);
    console.log("[Lunas Debug] Block mappings:", blockMappings);
    const exprValue = (expressionWithinAttributeValue || expression).trim();
    const mapping = blockMappings.find((m) => m.value === exprValue);
    if (mapping) {
      return {
        tempScript: blockScript,
        expressionOffsetInTempScript: mapping.tsPos[0],
        forVars: [],
        blockMappings,
      };
    } else {
      console.warn("[Lunas Debug] No mapping found for expression:", exprValue);
      return {
        tempScript: blockScript,
        expressionOffsetInTempScript: 0,
        forVars: [],
        blockMappings,
      };
    }
  }

  /**
   * Generate a virtual TS `for(...) { ... }` snippet from a Lunas :for node,
   * mapping each expression back to its original HTML offsets.
   */
  function prepareVirtualScriptForLoop(
    htmlDoc: TextDocument,
    loopNode: Node,
    originalScriptContent: string,
  ): {
    tempScript: string;
    mappings: {
      expression: string;
      htmlRange: { start: number; end: number };
      tsRange?: { start: number; end: number };
    }[];
  } {
    const rawFor = loopNode.attributes![":for"]!;
    const header = rawFor.slice(1, -1).trim();
    const htmlText = htmlDoc.getText();
    const mappings: {
      expression: string;
      htmlRange: { start: number; end: number };
      tsRange?: { start: number; end: number };
    }[] = [];
    if (loopNode.children) {
      loopNode.children.forEach((child) => {
        // attribute expressions
        if (child.attributes) {
          for (const attr of Object.entries(child.attributes)) {
            if (attr[0].startsWith(":")) {
              const raw = attr[1]!;
              const expr = raw.slice(1, -1);
              const start = htmlText.indexOf(raw, child.start) + 1;
              mappings.push({
                expression: expr,
                htmlRange: { start, end: start + expr.length },
              });
            }
          }
        }
        // text interpolations
        if (!child.tag) {
          const txt = htmlText.slice(child.start, child.end);
          const interp = /\$\{([^}]+)\}/g;
          let m: RegExpExecArray | null;
          while ((m = interp.exec(txt))) {
            const expr = m[1].trim();
            const start = child.start + m.index + 2;
            mappings.push({
              expression: expr,
              htmlRange: { start, end: start + expr.length },
            });
          }
        }
      });
    }
    const bodyLines = mappings.map((m) => `  ${m.expression};`);
    const snippetLines = [`for (${header}) {`, ...bodyLines, `}`];
    const tempScript =
      originalScriptContent + "\n" + snippetLines.join("\n") + "\n";
    const prefixOffset = originalScriptContent.length + 1;
    let cursor = prefixOffset + snippetLines[0].length + 1;
    mappings.forEach((m, idx) => {
      const line = bodyLines[idx];
      const col = line.indexOf(m.expression);
      const start = cursor + col;
      m.tsRange = { start, end: start + m.expression.length };
      cursor += line.length + 1;
    });
    console.log(
      "[Lunas Debug] prepareVirtualScriptForLoop tempScript:\n",
      tempScript,
    );
    return { tempScript, mappings };
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
    // Align diagnostics to the actual script block start
    const scriptBlockStartLine = startLine;
    let diagnostics: Diagnostic[] = [];

    // Ensure TS program is up-to-date
    tsService.getProgram();

    // Script block diagnostics
    {
      const syntaxDiagnostics = tsService.getSyntacticDiagnostics(virtualPath);
      const semanticDiagnostics = tsService.getSemanticDiagnostics(virtualPath);
      [...syntaxDiagnostics, ...semanticDiagnostics].forEach((tsDiag) => {
        if (
          tsDiag.file &&
          tsDiag.start !== undefined &&
          tsDiag.file.fileName === virtualPath
        ) {
          // Skip diagnostics from injected input declarations
          if (tsDiag.start < totalAdditionalPartChars) return;
          const diagStart = tsDiag.file.getLineAndCharacterOfPosition(
            tsDiag.start,
          );
          const diagEnd = tsDiag.file.getLineAndCharacterOfPosition(
            tsDiag.start + (tsDiag.length || 0),
          );
          // Calculate original document line for script block
          const mappedStartLine =
            diagStart.line - totalAdditionalPartLines + scriptBlockStartLine;
          const mappedEndLine =
            diagEnd.line - totalAdditionalPartLines + scriptBlockStartLine;
          // Only include diagnostics within the script block region
          if (
            mappedStartLine >= scriptBlockStartLine &&
            mappedStartLine <=
              scriptBlockStartLine + script.split("\n").length - 1
          ) {
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
                  line: mappedStartLine,
                  character: diagStart.character + INDENT_SIZE,
                },
                end: {
                  line: mappedEndLine,
                  character: diagEnd.character + INDENT_SIZE,
                },
              },
              message: ts.flattenDiagnosticMessageText(
                tsDiag.messageText,
                "\n",
              ),
              source: "Lunas TS",
              code: tsDiag.code,
            });
          }
        }
      });
    }

    // HTML Template Diagnostics
    const { html, startLine: hStart, indent: htmlIndent } = extractHTML(text);
    if (html && virtualPath && scriptContents.has(virtualPath)) {
      // [Lunas Debug] Print the full HTML content extracted
      console.log("[Lunas Debug] Full HTML content:\n", html);
      const htmlDoc = TextDocument.create(
        `${uri}__html_template__`,
        "html",
        change.document.version,
        html,
      );
      const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlDoc);
      // Debug: inspect parsed HTML document roots before traversal
      console.log("[Lunas Debug] parsedHtmlDoc.roots:");
      parsedHtmlDoc.roots.forEach((node, idx) => {
        console.log(
          `[Lunas Debug] Root ${idx}: tag=${node.tag}, start=${node.start}, end=${node.end}, ` +
            `attrs=${JSON.stringify(node.attributes)}, childrenCount=${node.children?.length}`,
        );
      });
      // [Lunas Debug] About to traverse parsedHtmlDoc.roots
      console.log(
        "[Lunas Debug] About to traverse parsedHtmlDoc.roots, count:",
        parsedHtmlDoc.roots.length,
      );
      const originalScriptContent = scriptContents.get(virtualPath)!;

      // Parse template into nested block nodes
      const blks = parseTemplateBlocks(htmlDoc, htmlService);
      // Generate virtual TS and mappings
      const { tempScript, mappings } = generateVirtualTsFromBlks(
        blks,
        originalScriptContent,
      );
      console.log(
        "[Lunas Debug] Generated virtual TS from blocks:\n",
        tempScript,
      );
      // Run TS diagnostics on virtual TS
      const originalScript = scriptContents.get(virtualPath)!;
      const originalVer = scriptVersions.get(virtualPath)!;
      scriptContents.set(virtualPath, tempScript);
      scriptVersions.set(virtualPath, originalVer + 1);
      const allDiags = [
        ...tsService.getSyntacticDiagnostics(virtualPath),
        ...tsService.getSemanticDiagnostics(virtualPath),
      ];
      console.log(
        "[Lunas Debug] Template Virtual diagnostics (allDiags):",
        allDiags.map((d) => ({
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          start: d.start,
          length: d.length,
        })),
      );
      console.log("[Lunas Debug] Generated mappings for template:", mappings);
      // Restore original script
      scriptContents.set(virtualPath, originalScript);
      scriptVersions.set(virtualPath, originalVer + 2);
      // Map and push diagnostics back to HTML
      allDiags.forEach((d) => {
        if (d.start === undefined || d.length === undefined) return;
        const m = mappings.find(
          (m) => d.start! >= m.tsPos[0] && d.start! < m.tsPos[1],
        );
        if (!m) return;
        // Use the entire expression range in HTML for the diagnostic
        const [origLine, origChar] = m.originalPos;
        const baseOffset = htmlDoc.offsetAt(
          Position.create(origLine, origChar),
        );
        const htmlStartOffset = baseOffset;
        const htmlEndOffset = baseOffset + m.value.length;
        const startPos = htmlDoc.positionAt(htmlStartOffset);
        const endPos = htmlDoc.positionAt(htmlEndOffset);
        diagnostics.push({
          severity:
            d.category === ts.DiagnosticCategory.Error
              ? DiagnosticSeverity.Error
              : d.category === ts.DiagnosticCategory.Warning
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Information,
          range: {
            start: {
              line: hStart + startPos.line,
              character: htmlIndent + startPos.character,
            },
            end: {
              line: hStart + endPos.line,
              character: htmlIndent + endPos.character,
            },
          },
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          source: "Lunas Template TS",
          code: d.code,
        });
      });
    }

    // (Removed HTML-template diagnostics filter so that errors inside `${...}` are still reported)
    // Deduplicate diagnostics by position and message
    {
      const uniqueMap = new Map<string, Diagnostic>();
      diagnostics.forEach((d) => {
        const key = `${d.range.start.line},${d.range.start.character},${d.range.end.line},${d.range.end.character},${d.message}`;
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, d);
        }
      });
      diagnostics = Array.from(uniqueMap.values());
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
    console.log(
      "[Lunas Debug] getLunasTemplateContext called with htmlBlockPosition:",
      htmlBlockPosition,
    );
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
              // Proxy the entire :for expression directly
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
      console.log("[Lunas Debug] onCompletion called with params:", params);
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
      console.log(
        "[Lunas Debug] Checking HTML block completions for position:",
        position,
        "hStart-hEnd:",
        hStart,
        hEnd,
      );
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

        // [Lunas Debug] Log templateContext for template completions
        if (templateContext) {
          console.log(
            "[Lunas Debug] onCompletion templateContext:",
            templateContext,
          );
        }

        if (templateContext && virtualPath) {
          const originalScriptContent = scriptContents.get(virtualPath);
          if (!originalScriptContent) return null;

          const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
          const nodeAtCursor = parsedHtmlDoc.findNodeAt(
            htmlTextDoc.offsetAt(relPosInHtmlBlock),
          );

          // [Lunas Debug] If handling :for attribute, log attributeValue
          if (templateContext.attributeName === ":for") {
            console.log(
              "[Lunas Debug] Handling :for completion, attributeValue:",
              templateContext.expression,
            );
          }

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

          // [Lunas Debug] Print the full virtual TS file content
          // console.log(
          //   "[Lunas Debug] Full virtual script content:\n",
          //   tempScript,
          // );

          const originalVersion = scriptVersions.get(virtualPath) || 0;
          scriptContents.set(virtualPath, tempScript);
          scriptVersions.set(virtualPath, originalVersion + 1);
          const program = tsService.getProgram();

          // [Lunas Debug] Log diagnostics for the virtual file
          const diags = [
            ...tsService.getSyntacticDiagnostics(virtualPath),
            ...tsService.getSemanticDiagnostics(virtualPath),
          ];
          console.log(
            "[Lunas Debug] Virtual file diagnostics:",
            diags.map((d) => ({
              message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
              start: d.start,
              length: d.length,
              fileName: d.file?.fileName,
            })),
          );

          // DEBUG: Try-catch with logs for tsService.getCompletionsAtPosition
          let tsCompletions;
          try {
            console.log(
              "[Lunas Debug] Calling getCompletionsAtPosition at offset:",
              expressionOffsetInTempScript + templateContext.offsetInExpression,
            );
            tsCompletions = tsService.getCompletionsAtPosition(
              virtualPath,
              expressionOffsetInTempScript + templateContext.offsetInExpression,
              {},
            );
            console.log("[Lunas Debug] Received completions:", tsCompletions);
          } catch (err) {
            console.error(
              "ERROR tsService.getCompletionsAtPosition failed:",
              err,
            );
          }

          // [Lunas Debug] Log completions count
          console.log(
            "[Lunas Debug] Completions count:",
            tsCompletions ? tsCompletions.entries.length : 0,
          );

          // Restore original script
          scriptContents.set(virtualPath, originalScriptContent);
          scriptVersions.set(virtualPath, originalVersion + 2); // Increment version again

          if (tsCompletions) {
            // [Lunas Debug] Log each completion entry's details
            tsCompletions.entries.forEach((entry) =>
              console.log(
                "[Lunas Debug] Completion entry:",
                entry.name,
                entry.kind,
              ),
            );
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

  // --- Provide hover for Lunas template expressions (HTML block) ---
  function provideLunasTemplateHover(
    uri: string,
    position: Position,
    doc: TextDocument,
    htmlService: ReturnType<typeof getHTMLLanguageService>,
    tsService: ts.LanguageService,
    scriptContents: Map<string, string>,
    scriptVersions: Map<string, number>,
  ): Hover | null {
    const text = doc.getText();
    const {
      html,
      startLine: hStart,
      endLine: hEnd,
      indent: htmlIndent,
    } = extractHTML(text);
    if (!(html && position.line >= hStart && position.line <= hEnd)) {
      return null;
    }
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

    // --- Insert logic to compute nearest :for scope node ---
    let scopeNode: Node | undefined;
    if (templateContext) {
      const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
      scopeNode = parsedHtmlDoc.findNodeAt(
        htmlTextDoc.offsetAt(relPosInHtmlBlock),
      );
      while (
        scopeNode &&
        !(scopeNode.attributes && scopeNode.attributes[":for"])
      ) {
        scopeNode = scopeNode.parent!;
      }
    }
    // --- End insertion ---

    // Find the virtual path for the script
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

    if (templateContext && virtualPath) {
      const originalScriptContent = scriptContents.get(virtualPath);
      if (!originalScriptContent) return null;

      // Call prepareTemporaryScriptForExpression and guard against undefined
      const prep = prepareTemporaryScriptForExpression(
        originalScriptContent,
        templateContext.expression,
        scopeNode,
        htmlTextDoc,
        htmlService,
        templateContext.attributeName,
        templateContext.expression,
      );
      if (!prep) {
        console.error(
          "[Lunas Debug] prepareTemporaryScriptForExpression returned undefined",
        );
        return null;
      }
      const { tempScript, expressionOffsetInTempScript, forVars } = prep;

      // Debug: show HTML snippet around cursor
      const htmlBlockText = htmlTextDoc.getText();
      const htmlIdx = htmlTextDoc.offsetAt(relPosInHtmlBlock);
      const htmlSnippet = [
        htmlIdx > 5
          ? htmlBlockText.slice(htmlIdx - 5, htmlIdx)
          : htmlBlockText.slice(0, htmlIdx),
        `|${htmlBlockText[htmlIdx]}|`,
        htmlBlockText.slice(htmlIdx + 1, htmlIdx + 6),
      ].join("");
      console.log("[Lunas Debug] HTML hover selection snippet:", htmlSnippet);

      let hoverTsOffset: number;
      if (templateContext.attributeName === ":for") {
        // Simple proxy: map directly into the for-header
        hoverTsOffset =
          expressionOffsetInTempScript + templateContext.offsetInExpression;
        console.log(
          "[Lunas Debug] Hover proxy for :for header, hoverTsOffset:",
          hoverTsOffset,
        );
      } else {
        hoverTsOffset =
          expressionOffsetInTempScript + templateContext.offsetInExpression;
      }
      // Debug: show TS mapping offset and snippet around that position
      console.log(
        "[Lunas Debug] Hover proxy to virtual TS offset:",
        hoverTsOffset,
      );
      const tsSnippetWindow = [
        hoverTsOffset > 5
          ? tempScript.slice(hoverTsOffset - 5, hoverTsOffset)
          : tempScript.slice(0, hoverTsOffset),
        `|${tempScript[hoverTsOffset]}|`,
        tempScript.slice(hoverTsOffset + 1, hoverTsOffset + 6),
      ].join("");
      console.log("[Lunas Debug] TS hover selection snippet:", tsSnippetWindow);
      console.log("[Lunas Debug] fullcode:", tempScript);

      const originalVersion = scriptVersions.get(virtualPath) || 0;
      scriptContents.set(virtualPath, tempScript);
      scriptVersions.set(virtualPath, originalVersion + 1);

      const quickInfo = tsService.getQuickInfoAtPosition(
        virtualPath,
        hoverTsOffset,
      );

      // [Lunas Debug] Log quickInfo.textSpan before restoring scriptContents
      if (quickInfo) {
        console.log("[Lunas Debug] quickInfo.textSpan:", quickInfo.textSpan);
      }

      scriptContents.set(virtualPath, originalScriptContent);
      scriptVersions.set(virtualPath, originalVersion + 2);

      if (quickInfo) {
        let displayString = ts.displayPartsToString(quickInfo.displayParts);
        // If hovering in a :for binding, remove the leading 'let ' from the hover label
        if (templateContext.attributeName === ":for") {
          displayString = displayString.replace(/^let\s+/, "");
        }
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
    return null;
  }
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

    // Try HTML block hover first
    const htmlHover = provideLunasTemplateHover(
      uri,
      params.position,
      doc,
      htmlService,
      tsService,
      scriptContents,
      scriptVersions,
    );
    if (htmlHover) return htmlHover;

    // Script Block Hover
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

    // Debug log at start
    console.log(
      "[Lunas Debug] onDefinition called with uri and position:",
      uri,
      position,
    );

    // HTML Block Definition
    const {
      html,
      startLine: hStart,
      endLine: hEnd,
      indent: htmlIndent,
    } = extractHTML(text);

    // --- HTML-level `:for` definition handling ---
    // (block intentionally removed or commented out to skip HTML-level jumps)
    /*
  if (html && position.line >= hStart && position.line <= hEnd) {
    // ... omitted HTML-level jump logic ...
  }
  */
    // --- End HTML-level `:for` definition handling ---
    if (html && position.line >= hStart && position.line <= hEnd) {
      const htmlTextDoc = TextDocument.create(uri, "html", doc.version, html);
      const relPosInHtmlBlock = Position.create(
        position.line - hStart,
        position.character - htmlIndent,
      );
      // Lunas テンプレート文脈を取得
      const templateContext = getLunasTemplateContext(
        htmlTextDoc,
        relPosInHtmlBlock,
        htmlService,
      );
      // :for 属性内の変数定義なら、元の HTML 側にジャンプする
      if (templateContext && templateContext.attributeName === ":for") {
        const exprStart = templateContext.expressionStartInHtmlBlock;
        const exprValue = templateContext.expression;
        // HTML 全体の行番号と文字位置を計算
        const htmlStartLine = exprStart.line + hStart;
        const htmlStartChar = exprStart.character + htmlIndent;
        const startPos = Position.create(htmlStartLine, htmlStartChar);
        const endPos = Position.create(
          htmlStartLine,
          htmlStartChar + exprValue.length,
        );
        return [Location.create(uri, Range.create(startPos, endPos))];
      }

      if (templateContext && virtualPath) {
        const originalScriptContent = scriptContents.get(virtualPath);
        if (!originalScriptContent) return null;

        const parsedHtmlDoc = htmlService.parseHTMLDocument(htmlTextDoc);
        const nodeAtCursor = parsedHtmlDoc.findNodeAt(
          htmlTextDoc.offsetAt(relPosInHtmlBlock),
        );

        // Use new signature for prepareTemporaryScriptForExpression
        const prep = prepareTemporaryScriptForExpression(
          originalScriptContent,
          templateContext.expression,
          nodeAtCursor,
          htmlTextDoc,
          htmlService,
          templateContext.attributeName,
          templateContext.expression,
        );

        if (!prep) {
          console.error(
            "[Lunas Debug] prepareTemporaryScriptForExpression returned undefined",
          );
          return null;
        }
        const { tempScript, expressionOffsetInTempScript, blockMappings } =
          prep;
        const originalVersion = scriptVersions.get(virtualPath) || 0;
        scriptContents.set(virtualPath, tempScript);
        scriptVersions.set(virtualPath, originalVersion + 1);

        // Use the correct offset for :for and all attributes
        const definitionOffset =
          expressionOffsetInTempScript + templateContext.offsetInExpression;
        const definitions = tsService.getDefinitionAtPosition(
          virtualPath,
          definitionOffset,
        );

        scriptContents.set(virtualPath, originalScriptContent);
        scriptVersions.set(virtualPath, originalVersion + 2);

        if (definitions) {
          console.log("[Lunas Debug] TS definitions returned:", definitions);
          const results: Location[] = [];
          const program = tsService.getProgram();
          if (!program) return results;

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
              // Skip input declaration section
              if (def.textSpan.start < totalAdditionalPartChars) {
                continue;
              }
              // Find matching blockMapping entry, preferring the loop header mapping first
              let mapped = blockMappings.find(
                (m) =>
                  def.textSpan.start >= m.tsPos[0] &&
                  def.textSpan.start < m.tsPos[1],
              );
              // Enhanced loop header mapping fallback
              if (mapped && mapped.value.startsWith("let [")) {
                // Try to more precisely map the variable name in the for-header
                const varName = def.name;
                const offsetInCond = mapped.value.indexOf(varName);
                const origLine = mapped.originalPos[0];
                const origChar =
                  mapped.originalPos[1] +
                  (offsetInCond >= 0 ? offsetInCond : 0);
                const htmlStart = Position.create(
                  hStart + origLine,
                  htmlIndent + origChar,
                );
                const htmlEnd = Position.create(
                  hStart + origLine,
                  htmlIndent + origChar + varName.length,
                );
                results.push(
                  Location.create(uri, Range.create(htmlStart, htmlEnd)),
                );
                continue;
              }
              if (mapped) {
                const [origLine, origChar] = mapped.originalPos;
                const htmlStart = Position.create(
                  hStart + origLine,
                  htmlIndent + origChar,
                );
                const htmlEnd = Position.create(
                  hStart + origLine,
                  htmlIndent + origChar + mapped.value.length,
                );
                results.push(
                  Location.create(uri, Range.create(htmlStart, htmlEnd)),
                );
                continue;
              }
              // Fallback to script-block mapping
              results.push({
                uri: uri,
                range: Range.create(
                  defStart.line -
                    totalAdditionalPartLines +
                    extractScript(text).startLine,
                  defStart.character + INDENT_SIZE,
                  defEnd.line -
                    totalAdditionalPartLines +
                    extractScript(text).startLine,
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

    // Script Block Definition
    console.log("[Lunas Debug] Script Block Definition check");
    const { script, startLine: scriptDeclLine } = extractScript(text);
    if (script && virtualPath) {
      // Include the first line of actual script content (no +1)
      const scriptContentActualStartLine = scriptDeclLine;
      const scriptLines = script.split("\n");
      // End line is startLine + number of lines
      const scriptContentActualEndLine =
        scriptContentActualStartLine + scriptLines.length;

      console.log(
        "[Lunas Debug] Script block lines:",
        scriptContentActualStartLine,
        "-",
        scriptContentActualEndLine,
        "Cursor:",
        position.line,
      );

      if (
        position.line >= scriptContentActualStartLine &&
        position.line <= scriptContentActualEndLine
      ) {
        console.log("[Lunas Debug] Cursor is inside script block");
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
        console.log("[Lunas Debug] localPositionResult:", localPositionResult);

        if (localPositionResult) {
          const definitions = tsService.getDefinitionAtPosition(
            virtualPath,
            localPositionResult.localPosition.offset,
          );
          console.log(
            "[Lunas Debug] tsService.getDefinitionAtPosition returned:",
            definitions,
          );

          if (definitions) {
            const results: Location[] = [];
            const program = tsService.getProgram();
            if (!program) {
              console.log("[Lunas Debug] No TS program found");
              return null;
            }

            for (const def of definitions) {
              const defSourceFile = program.getSourceFile(def.fileName);
              if (!defSourceFile) {
                console.log("[Lunas Debug] No source file for:", def.fileName);
                continue;
              }
              const defStart = defSourceFile.getLineAndCharacterOfPosition(
                def.textSpan.start,
              );
              const defEnd = defSourceFile.getLineAndCharacterOfPosition(
                def.textSpan.start + def.textSpan.length,
              );

              console.log(
                "[Lunas Debug] Definition:",
                def.fileName,
                "start:",
                defStart,
                "end:",
                defEnd,
                "textSpan:",
                def.textSpan,
              );

              if (def.fileName === virtualPath) {
                if (def.textSpan.start < totalAdditionalPartChars) {
                  console.log(
                    "[Lunas Debug] Skipping @Input definition at",
                    def.textSpan.start,
                  );
                  continue; // Skip @Input defs
                }
                results.push({
                  uri: uri,
                  range: Range.create(
                    defStart.line -
                      totalAdditionalPartLines +
                      scriptContentActualStartLine,
                    defStart.character + INDENT_SIZE,
                    defEnd.line -
                      totalAdditionalPartLines +
                      scriptContentActualStartLine,
                    defEnd.character + INDENT_SIZE,
                  ),
                });
                console.log(
                  "[Lunas Debug] Added script block location:",
                  results[results.length - 1],
                );
              } else {
                results.push({
                  uri: pathToFileURL(def.fileName).toString(),
                  range: Range.create(defStart, defEnd),
                });
                console.log(
                  "[Lunas Debug] Added external file location:",
                  results[results.length - 1],
                );
              }
            }
            console.log("[Lunas Debug] Returning definition results:", results);
            return results;
          } else {
            console.log("[Lunas Debug] No definitions found by TS");
          }
        } else {
          console.log("[Lunas Debug] localPositionResult is null");
        }
      } else {
        console.log("[Lunas Debug] Cursor is NOT inside script block");
      }
    } else {
      console.log("[Lunas Debug] No script or virtualPath");
    }

    return null;
  });

  documents.listen(connection);
  connection.listen();
}

init().catch((err) => {
  console.error("LSP Server initialization failed:", err);
});
