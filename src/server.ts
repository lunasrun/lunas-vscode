import {
  createConnection,
  Tài  liệu  văn  bản,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
} from "vscode-languageserver/node";

importnhập  { TextDocument } từ  "vscode-languageserver-textdocument";{ TextDocument } from "vscode-languageserver-textdocument";
importnhậpnhập * như  ts từ  "typescript";như ts từ "typescript";* as ts from "typescript";
importnhậpnhập * làm  con đường  từ  "con đường";làm con đường từ "con đường";* as path from "path";
importnhập  khẩu  {{
 GetLocationInBlock, getLocationInBlock,
 textLocationVisualizer, textLocationVisualizer,
}} từ  ". /utils /text-location";from "./utils/text-location";

// LSP の接続を作成
constkết nối   hằngkết   nối  hằng = tạo  Kết nối (ProposedFeatures.all);tạo Kết nối (ProposedFeatures.all);connection = createConnection(ProposedFeatures.all);
constTài liệu  liên  quanTài liệu  liên  quan: Văn bản văn bản<TextDocument> = Văn bản văn bản mới (TextDocument);Văn bản văn bản<TextDocument> = Văn bản văn bản mới (TextDocument);documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

constConst INDENT_SIZEConst INDENT_SIZE = 2;2;INDENT_SIZE = 2;
letlet scriptVersionlet scriptVersion = 0; // スクリプトのバージョン管理用0; // スクリプトのバージョン管理用scriptVersion = 0; // スクリプトのバージョン管理用

connectionKết nối.onInitialize((param: InitializeParam) => {onInitialize((params: InitializeParams) => {
 Trả  lại  { return {
 khả  năng:  { capabilities: {
 textDocumentSync: TextDocumentSyncKind. Tăng dần textDocumentSync: TextDocumentSyncKind.Incremental,
 completionProvider: { resolveProvider: true }, completionProvider: { resolveProvider: true },
      hoverProvider: true, // ホバー機能を有効化
     }, },
   }; };
})});

// `.lun` の `script:` を抽出
function extractScript(text: string): {
  script: string;
  startLine: number;
  endLine: number;
}} {{
  const scriptMatch = text.match(/script:\s*\n([\s\S]*?)(?:\n\s*style:|$)/);
  if (!scriptMatch) {
    return { script: "", startLine: 0, endLine: 0 };
   } }

  const scriptStart = text.indexOf("script:");
  const startLine = text.substring(0, scriptStart).split("\n").length;

  let scriptLines = scriptMatch[1].split("\n");
  scriptLines = scriptLines.map((line) =>
    line.startsWith("  ") ? line.slice(2) : line,
   ); );

  return {
    script: scriptLines.join("\n"),
    startLine,
    endLine: startLine + scriptLines.length - 1,
   }; };
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
    target: ts.ScriptTarget.ES2020,
    strict: true,
    lib: [
      "lib.dom.d.ts"
    ], // 標準ライブラリを追加
    allowJs: true, // JavaScript も許可
    noEmit: true, // ファイル出力しない
  }),
  getDefaultLibFileName: (options) => {
    const defaultLibPath = ts.getDefaultLibFilePath(options);
    console.log(`[DEBUG] getDefaultLibFileName → ${defaultLibPath}`);
    return defaultLibPath;
  },
  readFile: (fileName) => {
    if (fileName === tempFilePath) {
      return tempScriptContent;
    }
    if (fileName.includes("lib.es2020")) {
      console.log(`[DEBUG] readFile("${fileName}")`);
    }
    return ts.sys.readFile(fileName);
  },
  fileExists: (fileName) => {
    if (fileName === tempFilePath) {
      return true;
    }
    const exists = ts.sys.fileExists(fileName);
    if (fileName.includes("lib.es2020")) {
      console.log(`[DEBUG] fileExists("${fileName}") → ${exists}`);
    }
    return exists;
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
  const currentDate = new Date().toLocaleTimeString();
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

  // console.log(
  //   textLocationVisualizer(script, { type: "offset", offset: localOffset }),
  // );

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

console.log(tsService.getCompilerOptionsDiagnostics());

// LSP の接続を開始
documents.listen(connection);
connection.listen();
