import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1")
      await route.abort();
    else await route.continue();
  });
});

test("overview presents real local storage statistics at desktop and mobile widths", async ({
  page,
}, testInfo) => {
  await page.goto("/local-transfer");
  await page.getByLabel("Original file").setInputFiles({
    name: "overview-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Smart Storage ".repeat(16384)),
  });
  await page.getByRole("button", { name: "Prepare locally" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Prepared locally. Nothing has been uploaded.",
  );

  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("1 local staged file.");
  await expect(
    page.getByRole("heading", { name: "Verified local savings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", {
      name: /percent of original bytes saved locally/i,
    }),
  ).toHaveAttribute("aria-valuenow", /^(?!0$)\d+$/);

  for (const [name, width] of [
    ["desktop", 1440],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`overview-${name}.png`),
      fullPage: true,
    });
  }
});
