"use client";

import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import { prepareDisplayEquation, renderMath, splitMathText } from "../lib/math-content";

const MathFormula = memo(function MathFormula({ text, display }: { text: string; display: boolean }) {
  const html = useMemo(() => renderMath(text, display), [text, display]);
  return html
    ? <span className={display ? "translation-math display-math" : "translation-math"} dangerouslySetInnerHTML={{ __html: html }} />
    : <code className="translation-math-fallback">{text}</code>;
});

export function MathText({
  text,
  progress,
  renderText,
}: {
  text: string;
  progress: number;
  renderText: (text: string, offset: number) => ReactNode;
}) {
  return splitMathText(text).map((segment, index) => segment.math
    ? (
        <span
          key={index}
          className={progress >= segment.end ? undefined : "translation-math-pending"}
          aria-hidden={progress >= segment.end ? undefined : true}
        >
          <MathFormula text={segment.text} display={segment.display} />
        </span>
      )
    : <span key={index}>{renderText(segment.text, segment.start)}</span>);
}

export function DisplayEquation({ text, number, className, style }: {
  text: string;
  number: string;
  className: string;
  style?: CSSProperties;
}) {
  const equation = prepareDisplayEquation(text, number);
  return (
    <div className={`${className}${equation.annotation ? " annotated-equation" : ""}`} style={style}>
      <span className="equation-expression"><MathFormula text={equation.expression} display /></span>
      {equation.annotation && <span className="equation-annotation"><MathFormula text={equation.annotation} display={false} /></span>}
      {equation.number && <span className="equation-number">{equation.number}</span>}
    </div>
  );
}
