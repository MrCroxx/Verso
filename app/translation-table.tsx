import type { CSSProperties, ReactNode } from "react";
import type { LayoutBlock, SourceRect } from "../lib/translation-layout";

export function TranslationTable({ rows, className = "", style, contents, onHighlight, activeCells }: {
  rows: LayoutBlock[];
  className?: string;
  style?: CSSProperties;
  contents: ReactNode[];
  onHighlight?: (rects: SourceRect[]) => void;
  activeCells?: boolean[];
}) {
  const columns = Math.max(...rows.map((row) => row.sentences?.length ?? 1));
  const renderRow = (row: LayoutBlock, rowIndex: number) => {
    const cells = row.sentences ?? [{ text: row.text, sourceText: "", sourceRects: [] }];
    const offset = rows.slice(0, rows.indexOf(row)).reduce((sum, previous) => sum + (previous.sentences?.length ?? 1), 0);
    const Cell = row.kind === "table_header" ? "th" : "td";
    return <tr key={rowIndex}>{Array.from({ length: columns }, (_, column) => {
      const cell = cells[column];
      const interactive = Boolean(onHighlight && cell?.sourceRects.length && (activeCells?.[offset + column] ?? true));
      return <Cell key={column} scope={Cell === "th" ? "col" : undefined}
        className={interactive ? "mapped-table-cell" : undefined} tabIndex={interactive ? 0 : undefined}
        title={interactive ? cell.sourceText : undefined}
        onMouseEnter={() => onHighlight?.(interactive ? cell.sourceRects : [])} onMouseLeave={() => onHighlight?.([])}
        onFocus={() => onHighlight?.(interactive ? cell.sourceRects : [])} onBlur={() => onHighlight?.([])}>
        {cell && contents[offset + column]}
      </Cell>;
    })}</tr>;
  };
  const header = rows[0].kind === "table_header" ? rows[0] : undefined;
  const starts = header?.sentences?.map((cell) => cell.sourceRects[0]?.x);
  const source = header?.sourceRect;
  const widths = source && starts?.every((x) => x !== undefined)
    && starts.every((x, i) => !i || x! > starts[i - 1]!)
    ? starts.map((x, i) => ((starts[i + 1] ?? source.x + source.width) - x!) / (source.x + source.width - starts[0]!) * 100)
    : undefined;
  return <div className={`${className} source-table`} style={style} tabIndex={0}>
    <table style={{ minWidth: `${Math.max(24, columns * 9)}rem` }}>
      {widths?.every((width) => width > 5) && <colgroup>{widths.map((width, i) => <col key={i} style={{ width: `${width}%` }} />)}</colgroup>}
      {header && <thead>{renderRow(header, 0)}</thead>}
      <tbody>{rows.slice(header ? 1 : 0).map(renderRow)}</tbody>
    </table>
  </div>;
}
