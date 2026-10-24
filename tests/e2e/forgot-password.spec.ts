import { test, expect } from "@playwright/test";

const email = "recovery-fixture@example.invalid";

test("keeps the email visible, blocks duplicates and shows privacy-safe success", async ({
  page,
}) => {
  let complete!: () => void;
  const provider = new Promise<void>((resolve) => (complete = resolve));
  let requests = 0;
  await page.route("**/api/auth/reset", async (route) => {
    requests += 1;
    await provider;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message:
          "If this address can receive recovery mail, instructions will arrive shortly.",
      }),
    });
  });
  await page.goto("/forgot-password");
  const input = page.getByLabel("Email address");
  const submit = page.getByRole("button", {
    name: "Send recovery instructions",
  });
  await input.fill(email);
  await submit.click();
  await expect(input).toHaveValue(email);
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "Working…" })).toBeDisabled();
  await page.getByRole("button", { name: "Working…" }).click({ force: true });
  expect(requests).toBe(1);
  complete();
  await expect(page.getByRole("status")).toHaveText(
    "If this address can receive recovery mail, instructions will arrive shortly.",
  );
  await expect(input).toHaveValue(email);
  await expect(submit).toBeEnabled();
});

test("preserves the email and shows a generic error when recovery fails", async ({
  page,
}) => {
  await page.route("**/api/auth/reset", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RESET_REQUEST_FAILED", requestId: "fixture" },
      }),
    }),
  );
  await page.goto("/forgot-password");
  const input = page.getByLabel("Email address");
  await input.fill(email);
  await page
    .getByRole("button", { name: "Send recovery instructions" })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "The request could not complete. Please try again later.",
  );
  await expect(input).toHaveValue(email);
});
