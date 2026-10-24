import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StorageRing } from "../../src/components/storage-ring";
import { FileGlyph, filePresentation } from "../../src/components/file-glyph";

it.each([
  [1, 1000000, "&lt;0.01%"],
  [3, 1000, "0.30%"],
  [471, 1000, "47.1%"],
])("shows nonzero usage honestly for %s/%s", (used, quota, label) => {
  const html = renderToStaticMarkup(
    createElement(StorageRing, {
      used: BigInt(used),
      reserved: BigInt(0),
      quota: BigInt(quota),
    }),
  );
  expect(html).toContain(String(label));
});
it("shows file-specific glyphs and friendly labels rather than technical MIME metadata", () => {
  for (const [name, mime, label] of [
    ["report.pdf", "application/pdf", "PDF document"],
    ["budget.xlsx", null, "Spreadsheet"],
    ["photo.png", "image/png", "Image"],
    ["audio.mp3", "audio/mpeg", "Audio"],
    ["backup.zip", null, "Archive"],
  ]) {
    expect(filePresentation(name!, mime).label).toBe(label);
    const html = renderToStaticMarkup(
      createElement(FileGlyph, { name: name!, mime }),
    );
    expect(html).toContain("file-glyph");
    expect(html).not.toContain(mime ?? "application/");
  }
});
