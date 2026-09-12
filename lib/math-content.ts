import katex from "katex";

export type MathTextSegment = {
  text: string;
  math: boolean;
  display: boolean;
  start: number;
  end: number;
};

function characterCount(value: string) {
  return Array.from(value).length;
}

export function prepareDisplayEquation(text: string, number: string) {
  let expression = text.trim();
  if (expression.startsWith("$$") && expression.endsWith("$$")) {
    expression = expression.slice(2, -2).trim();
  } else if (expression.startsWith("\\[") && expression.endsWith("\\]")) {
    expression = expression.slice(2, -2).trim();
  }

  let annotation = "";
  let groupDepth = 0;
  let environmentDepth = 0;
  let delimiterDepth = 0;
  // Only separate a prose label outside math groups, matrices, and paired delimiters.
  for (const token of expression.matchAll(/\\(?:[a-zA-Z]+|.)|[{}]/g)) {
    const command = token[0];
    if (command === "{") groupDepth++;
    else if (command === "}") groupDepth--;
    else if (command === "\\begin") environmentDepth++;
    else if (command === "\\end") environmentDepth--;
    else if (command === "\\left") delimiterDepth++;
    else if (command === "\\right") delimiterDepth--;
    else if (
      (command === "\\quad" || command === "\\qquad")
      && groupDepth === 0 && environmentDepth === 0 && delimiterDepth === 0
      && token.index > 0
      && /^\s*\\text\s*\{/.test(expression.slice(token.index + command.length))
    ) {
      annotation = expression.slice(token.index + command.length).trim();
      expression = expression.slice(0, token.index).trim();
      break;
    }
  }

  const label = number.trim();
  return {
    expression,
    annotation,
    number: /^[\p{L}\p{N}]+(?:[.\-][\p{L}\p{N}]+)*$/u.test(label) ? `(${label})` : label,
  };
}

export function renderMath(expression: string, displayMode: boolean): string | null {
  if (expression.length > 10_000) return null;
  try {
    return katex.renderToString(expression, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 500,
      output: "htmlAndMathml",
    });
  } catch {
    return null;
  }
}

export function splitMathText(text: string): MathTextSegment[] {
  const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
  const segments: MathTextSegment[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > offset) {
      segments.push({
        text: text.slice(offset, index),
        math: false,
        display: false,
        start: characterCount(text.slice(0, offset)),
        end: characterCount(text.slice(0, index)),
      });
    }
    segments.push({
      text: match[1] ?? match[2] ?? match[3],
      math: true,
      display: match[1] === undefined,
      start: characterCount(text.slice(0, index)),
      end: characterCount(text.slice(0, index + match[0].length)),
    });
    offset = index + match[0].length;
  }
  if (offset < text.length) {
    segments.push({
      text: text.slice(offset),
      math: false,
      display: false,
      start: characterCount(text.slice(0, offset)),
      end: characterCount(text),
    });
  }
  return segments.length ? segments : [{
    text,
    math: false,
    display: false,
    start: 0,
    end: characterCount(text),
  }];
}
