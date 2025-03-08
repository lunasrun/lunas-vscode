import * as vscode from "vscode";
import { format } from "lunas-formatter";

export function activateFormatter(context: vscode.ExtensionContext) {
  let disposable = vscode.languages.registerDocumentFormattingEditProvider(
    "lunas",
    {
      async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
      ): Promise<vscode.TextEdit[]> {
        try {
          const fullText = document.getText();
          const formattedText = await format(fullText);

          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(fullText.length),
          );

          return [vscode.TextEdit.replace(fullRange, formattedText)];
        } catch (error: unknown) {
          vscode.window.showErrorMessage(`Formatting failed: ${String(error)}`);
          return [];
        }
      },
    },
  );

  context.subscriptions.push(disposable);
}
