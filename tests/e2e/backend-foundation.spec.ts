import { test, expect } from "@playwright/test";
test.beforeEach(async ({ context }) => {
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1")
      await route.abort();
    else await route.continue();
  });
});
test("protected routes redirect without contacting a provider and Auth pages expose honest setup", async ({
  page,
  request,
}) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Backend setup is required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeDisabled();
  for (const [path, title] of [
    ["/register", "Create your account"],
    ["/forgot-password", "Recover account access"],
    ["/update-password", "Choose a new password"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 850 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  const r = await request.post("/api/auth/login", {
    data: {
      email: "fixture@example.invalid",
      password: "fixture_password_123",
    },
  });
  expect(r.status()).toBe(503);
  expect((await r.json()).error.code).toBe("BACKEND_DISABLED");
  expect((await request.get("/api/files")).status()).toBe(503);
});
test("session-change notification fences an existing anonymous local download without erasing its checkpoint", async ({
  page,
}) => {
  await page.goto("/local-transfer");
  await page.getByLabel("Original file").setInputFiles({
    name: "privacy.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("account switch fixture"),
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Prepared locally.");
  const id = await page.evaluate(() =>
    localStorage.getItem("smart-storage-local-demo-id-v1"),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("smart-storage-session-change")),
  );
  await expect(page.getByRole("status")).toContainText("Session changed.");
  await expect(page.getByLabel("Original file")).toHaveValue("");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("smart-storage-local-demo-id-v1"),
    ),
  ).toBe(id);
  await page.reload();
  await expect(page.getByRole("status")).toContainText(
    "Local checkpoint recovered.",
  );
});
test("account-bound worker stages persist in isolated namespaces and reject account reassignment", async ({
  page,
}) => {
  const workerEvent = page.waitForEvent("worker");
  await page.goto("/local-transfer");
  const url = (await workerEvent).url();
  const result = await page.evaluate(async (url) => {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const a = new Worker(url),
      b = new Worker(url),
      reloaded = new Worker(url),
      anon = new Worker(url);
    const send = (w: Worker, data: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("WORKER_FIXTURE_TIMEOUT")),
          20000,
        );
        w.onmessage = (e) => {
          if (typeof e.data.progress !== "number") {
            clearTimeout(timer);
            resolve(e.data);
          }
        };
        w.onerror = () => {
          clearTimeout(timer);
          reject(Error("WORKER_FIXTURE_FAILED"));
        };
        w.postMessage(data);
      });
    try {
      const prepared = await send(a, {
        method: "prepare",
        ownerId: A,
        file: new File(["account fixture bytes"], "owned.txt", {
          type: "text/plain",
        }),
      });
      const other = await send(b, {
        method: "inspect",
        ownerId: B,
        id: prepared.id,
      });
      const reassigned = await send(a, {
        method: "inspect",
        ownerId: B,
        id: prepared.id,
      });
      const recovered = await send(reloaded, {
        method: "inspect",
        ownerId: A,
        id: prepared.id,
      });
      const restored = await send(reloaded, {
        method: "restore",
        ownerId: A,
        id: prepared.id,
      });
      const anonymous = await send(anon, {
        method: "inspect",
        id: prepared.id,
      });
      return {
        other: other.error,
        reassigned: reassigned.error,
        recovered: recovered.result,
        verified: restored.verified,
        downloadName: restored.downloadName,
        anonymous: anonymous.error,
      };
    } finally {
      a.terminate();
      b.terminate();
      reloaded.terminate();
      anon.terminate();
    }
  }, url);
  expect(result).toEqual({
    other: "CHECKPOINT_MISSING_OR_CORRUPT",
    reassigned: "STAGING_ACCOUNT_CHANGED",
    recovered: "recovered",
    verified: true,
    downloadName: "owned.txt",
    anonymous: "CHECKPOINT_MISSING_OR_CORRUPT",
  });
});
