import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1") {
      await route.abort();
      return;
    }
    await route.continue();
  });
});

test("local files presents a responsive table and selected-file inspector", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto("/local-transfer");

  for (const file of [
    {
      name: "research-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Verified local storage ".repeat(2048)),
    },
    {
      name: "reference-image.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(1024, 7),
    },
  ]) {
    await page.getByLabel("Original file").setInputFiles(file);
    await page.getByRole("button", { name: "Prepare locally" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Prepared locally. Nothing has been uploaded.",
    );
  }

  const fileTable = page.getByLabel("Local staged files");
  await expect(fileTable.getByText("Name", { exact: true })).toBeVisible();
  await expect(fileTable.getByText("Encoded", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "View details for research-notes.txt" })
    .click();
  await expect(
    page.getByText("Verified savings", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore & verify" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete local file" }),
  ).toBeVisible();
  const detailsGrid = await page
    .locator(".details-metadata")
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(detailsGrid.trim().split(" ").length).toBe(1);

  await page.getByPlaceholder("Search local files").fill("reference");
  await expect(
    page.getByRole("button", { name: "Clear filters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(
    page.getByRole("button", { name: "View details for research-notes.txt" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath("files-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("files-mobile.png"),
    fullPage: true,
  });
});
