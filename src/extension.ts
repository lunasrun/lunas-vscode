import * as vscode from "vscode";
import { format } from "lunas-formatter";

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.languages.registerDocumentFormattingEditProvider(
    "lunas",
    {
      async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
      ): Promise<vscode.TextEdit[]> {
        const fullText = document.getText(); // ドキュメントの全テキスト取得
        const formattedText = await format(fullText); // フォーマット関数を適用

        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(fullText.length),
        );

        return [vscode.TextEdit.replace(fullRange, formattedText)];
      },
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
