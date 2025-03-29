type LineColumnPosition = {
  type: "line-column";
  line: number;
  column: number;
};

type OffsetPosition = {
  type: "offset";
  offset: number;
};

type TextPosition = LineColumnPosition | OffsetPosition;

export function lineColumnToOffset(
  text: string,
  position: LineColumnPosition,
): OffsetPosition {
  console.log("lineColumnToOffset");
  const lines = text.split("\n");
  const offset =
    lines
      .slice(0, position.line)
      .reduce((sum, line) => sum + line.length + 1, 0) + position.column;

  return { offset, type: "offset" };
}

export function offsetToLineColumn(
  text: string,
  position: OffsetPosition,
): LineColumnPosition {
  const lines = text.split("\n");
  let offset = position.offset;
  let line = 0;
  let column = 0;

  while (line < lines.length) {
    if (offset <= lines[line].length) {
      column = offset;
      break;
    } else {
      offset -= lines[line].length + 1;
      line++;
    }
  }

  return { line, column, type: "line-column" };
}

/* 


getLocationInBlock


input
```
@input message1:string
@input message2:string
html:
  <div class="child">
          This is child component
      <div      >Message from parent: ${message1}</div>
       <div      >Message from parent: ${message2}</div>
  </div>
style:
  .child {
    border: dashed blue;
    padding: 5px;
  }






```




*/

export function getLocationInBlock(
  globalText: string,
  localBlockStartLine: number,
  localBlockEndLine: number,
  indentSize: number,
  globalPosition: LineColumnPosition,
  additionalPositionSize: number,
): { localPosition: OffsetPosition } | null {
  /* startLineから1行ずつindentSizeを引いた行を取得し、文字数を結合していく */
  /* もしindentSizeよりLine.lengthが小さければ、0を返す */
  const lines = globalText.split("\n");
  let currentLine = localBlockStartLine - 1;
  let localOffset = -1 + additionalPositionSize;

  if (
    globalPosition.line < localBlockStartLine ||
    globalPosition.line > localBlockEndLine
  ) {
    console.error(
      "Global position is out of block range" +
        "\n" +
        `globalPosition: ${globalPosition.line} and localBlockStartLine: ${localBlockStartLine}, localBlockEndLine: ${localBlockEndLine}`,
    );
    return null;
  }

  while (currentLine < lines.length) {
    /* globalPositionがこの行にあるかどうかを確認 */
    // もしglobalPositionがこの行にあるとしたら、そのlocalオフセットを返す処理を追加
    // 念の為、outOfRangeになった場合、0を返す処理を追加
    currentLine++;
    localOffset += 1;

    const line = lines[currentLine];

    if (line.length <= indentSize) {
      if (globalPosition.line === currentLine) {
        return { localPosition: { type: "offset", offset: localOffset } };
      }
      continue;
    }

    const trimmedLine = lines[currentLine].slice(indentSize);
    if (globalPosition.line === currentLine) {
      if (globalPosition.column - 1 - indentSize <= trimmedLine.length) {
        return {
          localPosition: {
            type: "offset",
            offset: localOffset + globalPosition.column - 1 - indentSize,
          },
        };
      } else {
        console.error(
          `the length of the line ${trimmedLine.length} is smaller than the global position ${globalPosition.column - 1 - indentSize}`,
        );
        return null;
      }
    }

    localOffset += trimmedLine.length;
  }

  console.error("out of range");
  return null;
}

export function textLocationVisualizer(
  text: string,
  position: TextPosition,
): string {
  const textPositionLineColumn =
    position.type === "line-column"
      ? position
      : offsetToLineColumn(text, position);

  const line = textPositionLineColumn.line;
  const column = textPositionLineColumn.column;
  const lineContent = text.split("\n")[line];
  if (lineContent === undefined) {
    return `line ${line} is out of range`;
  }
  const splittedLine = lineContent.split("");
  /* splittedLineのposition.chalacter文字目に->を追加する */
  splittedLine.splice(column, 0, "->");
  // <-も追加する
  splittedLine.splice(column + 2, 0, "<-");

  return splittedLine.join("");
}
