import { expect, test } from "@playwright/test";

test("explicit themes persist, system reacts, and other tabs synchronize", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const theme = page.getByLabel("Theme", { exact: true });
  await expect(theme).toHaveValue("light");
  await theme.selectOption("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(theme).toHaveValue("dark");
  await theme.selectOption("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  const other = await context.newPage();
  await other.goto("/");
  await other.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(theme).toHaveValue("light");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  expect(errors).toEqual([]);
});

test("stored dark is applied before DOM ready without hydration errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem("smart-storage-theme", "dark");
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.readyTheme =
        document.documentElement.dataset.theme;
    });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-ready-theme",
    "dark",
  );
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  expect(errors).toEqual([]);
});

test("unavailable storage preserves default and permits an in-memory selection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage unavailable");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
});

test("navigation supports keyboard collapse and mobile disclosure", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCSS(
    "outline-style",
    "solid",
  );
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCSS(
    "outline-width",
    "2px",
  );
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Theme", { exact: true })).toBeFocused();
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  const collapse = page.getByRole("button", { name: "Collapse navigation" });
  await collapse.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Expand navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".desktop-nav")).toHaveCSS("width", "64px");
  await expect(
    page.getByRole("link", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 375, height: 812 });
  const disclosure = page.locator(".mobile-nav summary");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".mobile-nav a")).toBeVisible();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveCSS(
    "min-height",
    "44px",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".mobile-nav a")).toBeHidden();
});

test("both themes reflow at common widths and reduced motion is honored", async ({
  page,
}) => {
  await page.goto("/");
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    for (const width of [320, 375, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByRole("heading", { name: "Smart Storage" }),
      ).toBeVisible();
      if (width === 320 || width === 1440)
        await page.screenshot({
          path: `test-results/foundation-${theme}-${width}.png`,
          fullPage: true,
        });
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    parseFloat(
      await page
        .locator("html")
        .evaluate((element) =>
          getComputedStyle(element)
            .getPropertyValue("--motion-duration")
            .trim(),
        ),
    ),
  ).toBe(0);
  await page.emulateMedia({ forcedColors: "active" });
  await page.getByLabel("Theme", { exact: true }).focus();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveCSS(
    "outline-style",
    "solid",
  );
  await page.emulateMedia({ forcedColors: "none" });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByLabel("Theme", { exact: true })).toBeVisible();
});
