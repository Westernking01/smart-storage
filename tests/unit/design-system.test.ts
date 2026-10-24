import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, IconButton } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { Badge } from "../../src/components/ui/badge";
import { Surface } from "../../src/components/ui/surface";
import { Skeleton } from "../../src/components/ui/skeleton";
import { Separator } from "../../src/components/ui/separator";
import { SegmentedProgress } from "../../src/components/segmented-progress";
import { parseTheme, resolveTheme } from "../../src/lib/theme";
import { readFileSync } from "node:fs";

describe("design system contracts", () => {
  it("defaults safely and follows the OS only after explicit system selection", () => {
    expect(parseTheme(null)).toBe("light");
    expect(parseTheme("unexpected")).toBe("light");
    expect(resolveTheme(parseTheme(null), true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("preserves native button, input and accessibility attributes", () => {
    expect(
      renderToStaticMarkup(createElement(Button, { disabled: true }, "Save")),
    ).toContain('type="button"');
    expect(
      renderToStaticMarkup(
        createElement(IconButton, { "aria-label": "Open details" }),
      ),
    ).toContain('aria-label="Open details"');
    const input = renderToStaticMarkup(
      createElement(Input, {
        id: "filename",
        "aria-invalid": true,
        "aria-describedby": "error",
        disabled: true,
      }),
    );
    expect(input).toContain('aria-describedby="error"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('disabled=""');
  });
  it("renders readable status and semantic neutral surfaces without fake progress", () => {
    expect(
      renderToStaticMarkup(createElement(Badge, { tone: "warning" }, "Paused")),
    ).toContain("Paused");
    expect(
      renderToStaticMarkup(
        createElement(Surface, { "aria-label": "File metadata" }),
      ),
    ).toContain("<section");
    expect(renderToStaticMarkup(createElement(Separator))).toContain("<hr");
    expect(renderToStaticMarkup(createElement(Skeleton))).toContain(
      'aria-hidden="true"',
    );
    const progress = renderToStaticMarkup(
      createElement(SegmentedProgress, {
        value: 37.5,
        label: "37.5 percent saved locally",
        segments: 8,
      }),
    );
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow="38"');
    expect(progress.match(/is-complete/g)).toHaveLength(3);

    const nearCompleteProgress = renderToStaticMarkup(
      createElement(SegmentedProgress, {
        value: 99.8,
        label: "99.8 percent saved locally",
        segments: 8,
      }),
    );
    expect(nearCompleteProgress.match(/is-complete/g)).toHaveLength(7);
  });
  it("keeps specified text, controls and action pairings above contrast thresholds", () => {
    const css = readFileSync(
      new URL("../../src/styles/tokens.css", import.meta.url),
      "utf8",
    );
    const blocks = css.split(':root[data-theme="dark"]');
    function values(block: string) {
      return Object.fromEntries(
        [...block.matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map((match) => [
          match[1],
          match[2],
        ]),
      );
    }
    function luminance(hex: string) {
      const [r, g, b] = [1, 3, 5].map((index) => {
        const value = parseInt(hex.slice(index, index + 2), 16) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    }
    function contrast(a: string, b: string) {
      const pair = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (pair[0] + 0.05) / (pair[1] + 0.05);
    }
    for (const block of blocks) {
      const tokens = values(block);
      for (const background of ["background", "card", "secondary", "accent"]) {
        for (const text of [
          "foreground",
          "text-secondary",
          "muted-foreground",
          "success",
          "warning",
          "danger",
          "info",
        ]) {
          expect(
            contrast(tokens[text], tokens[background]),
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const background of ["background", "card", "secondary"])
        expect(
          contrast(tokens.input, tokens[background]),
        ).toBeGreaterThanOrEqual(3);
      for (const fill of ["primary", "primary-hover", "primary-pressed"])
        expect(
          contrast(tokens["primary-foreground"], tokens[fill]),
        ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
