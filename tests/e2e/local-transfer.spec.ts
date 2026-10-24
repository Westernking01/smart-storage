import { test, expect, chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
test.beforeEach(async ({ context }) => {
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1")
      await route.abort();
    else await route.continue();
  });
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
test("local worker preparation survives reload and restores a multi-block file exactly", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      external.push(url.hostname);
      await route.abort();
    } else await route.continue();
  });
  await page.goto("/local-transfer");
  const input = Buffer.alloc(8 * 1024 * 1024 + 39, 65);
  await page.getByLabel("Original file").setInputFiles({
    name: "local.bin",
    mimeType: "application/octet-stream",
    buffer: input,
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Preparation and exact restoration verified locally. Nothing has been uploaded.",
    { timeout: 60000 },
  );
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`local-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.reload();
  await expect(page.getByRole("status")).toHaveText(
    "1 local staged file recovered.",
  );
  await page.getByRole("button", { name: "Restore & verify" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Exact restoration verified locally",
    { timeout: 60000 },
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Save verified original bytes" }).click(),
  ]);
  expect(sha(readFileSync((await download.path())!))).toBe(sha(input));
  expect(download.suggestedFilename()).toBe("local.bin");
  expect(external).toEqual([]);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local file" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Local staged file deleted.",
  );
  await expect(
    page.getByRole("heading", { name: "Your local workspace is empty" }),
  ).toBeVisible();
});
test("corrupt durable checkpoint fails closed on reload", async ({ page }) => {
  await page.goto("/local-transfer");
  await page.getByLabel("Original file").setInputFiles({
    name: "small.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("small local fixture"),
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Prepared locally.");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("smart-storage-local-staging-v1", 1);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("checkpoints", "readwrite"),
          store = tx.objectStore("checkpoints"),
          keys = store.getAllKeys();
        keys.onsuccess = () => {
          const id = keys.result[0];
          const get = store.get(id);
          get.onsuccess = () =>
            store.put({ ...get.result, text: get.result.text + " " }, id);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText(
    "Stopped: STAGING_LIST_CORRUPT. No cloud request was made.",
  );
  await expect(
    page.getByRole("link", { name: "Save verified original bytes" }),
  ).toHaveCount(0);
});
test("missing staged data cannot produce a verified download", async ({
  page,
}) => {
  await page.goto("/local-transfer");
  await page.getByLabel("Original file").setInputFiles({
    name: "missing.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(128, 65),
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Prepared locally.");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("smart-storage-local-staging-v1", 1);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("blocks", "readwrite");
        tx.objectStore("blocks").clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await expect(page.getByRole("status")).toContainText(
    "1 local staged file recovered",
  );
  await page.getByRole("button", { name: "Restore & verify" }).click();
  await expect(page.getByRole("status")).toContainText("STAGED_DATA_MISSING");
  await expect(
    page.getByRole("link", { name: "Save verified original bytes" }),
  ).toHaveCount(0);
});
test("prepared checkpoint survives a real persistent Chromium restart", async ({}, testInfo) => {
  test.setTimeout(90000);
  const profile = resolve(testInfo.outputPath("disposable-browser-profile"));
  mkdirSync(profile, { recursive: true });
  const launch = async () => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).hostname !== "127.0.0.1")
        await route.abort();
      else await route.continue();
    });
    return context;
  };
  let context = await launch();
  try {
    let page = context.pages()[0];
    await page.goto("http://127.0.0.1:3100/local-transfer");
    await page.getByLabel("Original file").setInputFiles({
      name: "restart.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(127, 65),
    });
    await page
      .getByRole("button", { name: "Prepare locally", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Prepared locally.");
    await context.close();
    context = await launch();
    page = context.pages()[0];
    await page.goto("http://127.0.0.1:3100/local-transfer");
    await expect(page.getByRole("status")).toContainText(
      "1 local staged file recovered.",
    );
    await page.getByRole("button", { name: "Restore & verify" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Exact restoration verified locally",
    );
  } finally {
    await context.close();
  }
});

test("workspace lists, searches, filters, sorts and renames real staged files", async ({
  page,
}) => {
  await page.goto("/local-transfer");
  for (const fixture of [
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("notes notes notes"),
    },
    { name: "photo.png", mimeType: "image/png", buffer: Buffer.alloc(256, 7) },
  ]) {
    await page.getByLabel("Original file").setInputFiles(fixture);
    await page.getByRole("button", { name: "Prepare locally" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Prepared locally. Nothing has been uploaded.",
      { timeout: 30000 },
    );
  }
  await expect(
    page.getByText("notes.txt", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("photo.png", { exact: true }).first(),
  ).toBeVisible();
  await page.getByPlaceholder("Search local files").fill("notes");
  await expect(page.getByText("photo.png", { exact: true })).toHaveCount(0);
  await page.getByPlaceholder("Search local files").fill("");
  await page.getByLabel("Filter by file type").selectOption("image");
  await expect(
    page.getByText("photo.png", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Filter by file type").selectOption("all");
  await page.getByLabel("Sort local files").selectOption("name");
  await page.getByText("notes.txt", { exact: true }).first().click();
  page.once("dialog", (dialog) => dialog.accept("work-notes.txt"));
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(
    page.getByText("work-notes.txt", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("work-notes.txt", { exact: true }).first(),
  ).toBeVisible();
});
