import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "@boxicons/react/Home";
import { cn } from "../../src/lib/utils";

describe("application foundation", () => {
  it("merges conditional Tailwind utilities without conflicting spacing", () => {
    expect(cn("px-4", false && "hidden", "px-6")).toBe("px-6");
  });
  it("renders the official Boxicons component as an SVG", () => {
    expect(
      renderToStaticMarkup(createElement(Home, { "aria-hidden": true })),
    ).toContain("<svg");
  });
});
