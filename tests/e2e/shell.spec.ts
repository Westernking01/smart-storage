import { expect, test } from "@playwright/test";

test("minimal shell is accessible and stays light under dark OS preference", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page).toHaveTitle("Smart Storage");
  await expect(
    page.getByRole("heading", { name: "Smart Storage" }),
  ).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page.locator(".desktop-nav svg")).toHaveCount(2);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.setViewportSize({ width: 320, height: 640 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
