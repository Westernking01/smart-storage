import { test, expect } from "@playwright/test";

const destinations = [
  { label: "My files", route: "/my-files", heading: "My files" },
  { label: "Compress", route: "/compress", heading: "Compress" },
  { label: "Recent files", route: "/recent-files", heading: "Recent files" },
  { label: "Local storage", route: "/local-storage", heading: "Local storage" },
  {
    label: "Development cloud storage",
    route: "/development-cloud",
    heading: "Development cloud storage",
  },
];

test.beforeEach(async ({ page, baseURL }) => {
  // No credentials/cookies, no API submissions or external browser requests.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL!).origin) return route.abort();
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"OFFLINE_TEST"}',
      });
    return route.continue();
  });
});

for (const mobile of [false, true]) {
  for (const destination of destinations) {
    test(`${mobile ? "mobile" : "desktop"}: ${destination.label} supports click, direct URL and refresh`, async ({
      page,
    }) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const link = page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: new RegExp(`^${destination.label}`) });
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${destination.route}$`));
      await expect(
        page.getByRole("heading", { name: destination.heading, exact: true }),
      ).toBeVisible();
      await page.goto(destination.route, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: destination.heading, exact: true }),
      ).toBeVisible();
      if (destination.route === "/development-cloud") {
        await expect(
          page.getByText(
            /You are not signed in\.|Development cloud storage is disabled\./,
          ),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /upload/i })).toHaveCount(
          0,
        );
      } else {
        await expect(page.getByLabel("Original file")).toHaveCount(
          destination.route === "/compress" ? 1 : 0,
        );
        await expect(
          page.getByLabel("Local browser storage metrics"),
        ).toHaveCount(destination.route === "/local-storage" ? 1 : 0);
        if (destination.route === "/recent-files")
          await expect(page.getByLabel("File details")).toHaveCount(0);
      }
    });
  }
}
