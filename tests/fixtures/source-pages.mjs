export const proseLines = [
  "Readers can translate ordinary prose without losing important details.",
  "Local source analysis preserves the original order of every sentence.",
  "The application retains complete translations and precise highlights.",
  "Small changes to the output format reduce unnecessary model work.",
  "Reliable page boundaries provide context for the following paragraph.",
  "Uncertain pages continue to use the complete visual translation path.",
];

export function sourceFixture() {
  const words = [];
  for (let line = 0; line < proseLines.length; line++) {
    const parts = proseLines[line].split(" ");
    const letters = proseLines[line].length;
    let x = 0.12;
    for (const text of parts) {
      const width = text.length / letters * 0.75;
      words.push({ text, line, block: line < 3 ? 1 : 2,
        rect: { x, y: 0.15 + line * 0.026 + (line >= 3 ? 0.03 : 0), width, height: 0.016 } });
      x += width + 0.75 / letters;
    }
  }
  return { width: 600, height: 800, words, method: "pdf" };
}

export function makeSourcePdf({ graphics = false, columns = false, formula = false, hidden = false, code = false } = {}) {
  const lines = code ? ["Python", "1  agent = Agent(", '2      name="Weather agent",', '3      instructions="Use tools",', "4      tools=[get_weather],", "5  )"] : formula ? [...proseLines, "The equation is x = y + z."] : proseLines;
  let stream = "BT /F1 12 Tf\n";
  if (hidden) stream += "3 Tr\n";
  lines.forEach((line, i) => {
    const x = columns && i >= 3 ? 320 : 72;
    const y = 680 - (columns ? i % 3 : i) * 20;
    stream += `1 0 0 1 ${x} ${y} Tm (${line.replace(/[()\\]/g, "\\$&")}) Tj\n`;
  });
  stream += "ET\n";
  if (graphics) stream += "72 300 200 120 re S\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /${code ? "Courier" : "Helvetica"} >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
