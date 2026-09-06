import React from "react";
export default function PdfText({ text }: { text: string }) {
  return <>{text.split(/([\uf06c\uf0b7\uf0d8])/g).map((part, i) =>
    /^[\uf06c\uf0b7\uf0d8]$/.test(part)
      ? <span key={i} className="pdf-list-glyph" data-glyph={part === "\uf0d8" ? "▸" : "•"}>{part}</span>
      : part
  )}</>;
}
