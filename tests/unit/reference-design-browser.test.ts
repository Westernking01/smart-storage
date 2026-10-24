import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { build } from "vite";
import { createServer, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import {
  chromium,
  expect as playwrightExpect,
  type Browser,
  type Page,
} from "@playwright/test";
const browserExpect = playwrightExpect.configure({ timeout: 15000 });
let server: Server, browser: Browser, page: Page, origin: string;
const directory = resolve(".cache/reference-design-build");
const shots = resolve(".cache/reference-design-screenshots");
beforeAll(async () => {
  await mkdir(shots, { recursive: true });
  await mkdir(resolve(".cache/account-settings-screenshots"), {
    recursive: true,
  });
  await build({
    configFile: false,
    envDir: false,
    logLevel: "error",
    oxc: { jsx: { development: false } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: {
      alias: {
        "@": resolve("src"),
        "next/navigation": resolve("tests/fixtures/transfer-router.tsx"),
        "next/link": resolve("tests/fixtures/transfer-router.tsx"),
      },
    },
    build: {
      outDir: directory,
      emptyOutDir: false,
      lib: {
        entry: resolve("tests/fixtures/reference-design-browser.tsx"),
        formats: ["es"],
        fileName: "design",
        cssFileName: "design",
      },
    },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    if (!extname(url.pathname)) {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/design.css"></head><body><div id="root"></div><script type="module" src="/design.js"></script></body></html>',
      );
      return;
    }
    const path = resolve(directory, "." + url.pathname);
    if (!path.startsWith(directory + sep)) {
      res.writeHead(403).end();
      return;
    }
    const mime: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    };
    void readFile(path).then(
      (bytes) => {
        res.setHeader(
          "Content-Type",
          mime[extname(path)] ?? "application/octet-stream",
        );
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NO_ADDRESS");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((done) => server.close(() => done()));
}, 30000);
beforeEach(async ({ task }) => {
  page = await browser.newPage();
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await page.waitForFunction("!!window.designHarness");
  if (!task.name.startsWith("account settings")) {
    await page.evaluate("transferHarness.seed()");
    await page.evaluate("transferHarness.seedPicker()");
  }
});
afterEach(async () => {
  await page?.close();
});
const mount = (name: string, enabled = true) =>
  page.evaluate(`designHarness.mount('${name}',${enabled})`);
it("captures equivalent reference viewports for visual comparison", async () => {
  const target = resolve(
    ".cache/visual-fidelity",
    process.env.SS_SCREENSHOT_STAGE === "before" ? "before" : "after",
  );
  await mkdir(target, { recursive: true });
  for (const [name, height] of [
    ["overview", 1206],
    ["files", 941],
    ["cloud", 941],
    ["register", 1028],
  ] as const) {
    await page.setViewportSize({ width: 1440, height });
    await mount(name);
    await page.locator("h1").waitFor();
    if (name === "overview")
      await browserExpect(page.getByLabel("Original file")).toBeEnabled();
    if (name === "files")
      await browserExpect(
        page.getByRole("button", { name: "New folder", exact: true }),
      ).toBeEnabled();
    await page.screenshot({ path: resolve(target, `${name}-1440.png`) });
    await writeFile(
      resolve(target, `${name}-1440.metrics.json`),
      JSON.stringify(
        await page.evaluate(() => ({
          viewport: { width: innerWidth, height: innerHeight },
          pageHeight: document.documentElement.scrollHeight,
          boxes: [
            ...document.querySelectorAll(
              ".dashboard-sidebar,.page-heading,h1,.overview-kpis,.reference-panel,.storage-ring,.explorer-entry,.explorer-selection,.auth-page,.auth-visual,.auth-form .ui-input",
            ),
          ].map((el) => {
            const r = el.getBoundingClientRect(),
              c = getComputedStyle(el);
            return {
              selector: el.className,
              tag: el.tagName,
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              fontSize: c.fontSize,
              padding: c.padding,
              overflowY: c.overflowY,
            };
          }),
        })),
        null,
        2,
      ),
    );
  }
}, 60000);
it("compact file types, full-name disclosure and selection keep one contextual restore action", async () => {
  await page.setViewportSize({ width: 1440, height: 941 });
  await page.evaluate(() => {
    const base = window.fetch;
    window.fetch = async (input, init) => {
      const response = await base(input, init);
      if (
        new URL(String(input), location.origin).pathname !==
          "/api/file-explorer" ||
        (init?.method && init.method !== "GET")
      )
        return response;
      const data = await response.json();
      const entry = data.files[0];
      const specs = [
        [
          "Annual report and supporting material for the development workspace.pdf",
          "application/pdf",
          "document",
        ],
        [
          "Quarterly budget.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "document",
        ],
        ["Landscape.png", "image/png", "image"],
        ["Recording.mp3", "audio/mpeg", "audio"],
        ["Source archive.zip", "application/zip", "archive"],
        ["Project notes.md", "text/markdown", "document"],
      ];
      data.files.push(
        ...specs.map(([name, mime, category], i) => ({
          ...entry,
          file: {
            ...entry.file,
            id: `dddddddd-dddd-4ddd-8ddd-${String(i + 1).padStart(12, "0")}`,
            displayName: name,
            originalName: name,
            originalMime: mime,
            category,
          },
        })),
      );
      data.folders = ["Projects", "Documents"].map((name, i) => ({
        id: `eeeeeeee-eeee-4eee-8eee-${String(i + 1).padStart(12, "0")}`,
        parentId: null,
        name,
        revision: 0,
      }));
      return Response.json(data);
    };
  });
  await mount("files");
  const name =
    "Annual report and supporting material for the development workspace.pdf";
  const select = page.getByRole("button", {
    name: `Select ${name}`,
    exact: true,
  });
  await select.focus();
  await page.keyboard.press("Space");
  await browserExpect(select).toHaveAttribute("aria-pressed", "true");
  await browserExpect(
    page.getByRole("complementary", { name: "Selected file" }),
  ).toContainText(name);
  await browserExpect(
    page.getByRole("button", { name: "Download and restore", exact: true }),
  ).toHaveCount(1);
  expect(
    await page
      .locator(".explorer-entry .ui-button")
      .filter({ hasText: "Download and restore" })
      .count(),
  ).toBe(0);
  expect(await page.locator(".explorer-entry").allTextContents()).not.toContain(
    "application/pdf",
  );
  await browserExpect(select.locator("strong")).toHaveAttribute("title", name);
  const tile = await select.locator("..").boundingBox();
  expect(tile?.height).toBeLessThanOrEqual(150);
  await noOverflow();
  await mkdir(resolve(".cache/visual-fidelity/after"), { recursive: true });
  await page.screenshot({
    path: resolve(".cache/visual-fidelity/after/files-populated-1440.png"),
  });
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await browserExpect(
    page.getByRole("complementary", { name: "Selected file" }),
  ).toContainText(name);
  await page.screenshot({
    path: resolve(".cache/visual-fidelity/after/files-list-1440.png"),
  });
});
const noOverflow = async () => {
  const report = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    path: location.pathname,
    boxes: [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12)
      .map((e) => ({
        tag: e.tagName,
        cls: e.className,
        right: e.getBoundingClientRect().right,
        width: e.getBoundingClientRect().width,
      })),
  }));
  if (report.scroll > report.width)
    await page.screenshot({
      path: resolve(
        shots,
        `overflow-${report.path.replaceAll("/", "-")}-${report.width}.png`,
      ),
      fullPage: true,
    });
  expect(report.scroll, JSON.stringify(report)).toBeLessThanOrEqual(
    report.width,
  );
};
it.each([320, 390, 768, 1024, 1440])(
  "all workspace pages fit and keep navigation at %spx",
  async (width) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of [
      "overview",
      "files",
      "compress",
      "recent",
      "local",
      "cloud",
    ]) {
      await mount(name);
      await browserExpect(
        page.getByRole("navigation", { name: "Primary" }),
      ).toBeVisible();
      await browserExpect(page.locator("h1")).toBeVisible();
      if (["overview", "compress", "recent", "local"].includes(name))
        await browserExpect(page.getByRole("status").first()).not.toContainText(
          "Loading",
        );
      if (name === "files")
        await browserExpect(
          page.getByRole("button", { name: "New folder", exact: true }),
        ).toBeEnabled();
      await noOverflow();
      expect(
        await page.evaluate(
          () =>
            [
              ...document.querySelectorAll(
                ".dashboard-main,.workspace,.dashboard-sidebar",
              ),
            ].filter((el) => {
              const c = getComputedStyle(el);
              return (
                ["auto", "scroll"].includes(c.overflowY) &&
                el.scrollHeight > el.clientHeight + 1
              );
            }).length,
        ),
      ).toBe(0);
      await page.screenshot({
        path: resolve(shots, `${name}-${width}.png`),
        fullPage: true,
      });
    }
  },
  60000,
);
it.each([390, 1440])(
  "split authentication inputs, feedback and visibility work at %spx",
  async (width) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ["login", "register", "reset", "update"]) {
      await mount(mode);
      await browserExpect(page.locator("h1")).toBeVisible();
      const field =
        mode === "update"
          ? page.getByLabel("Password", { exact: true })
          : page.getByLabel("Email address", { exact: true });
      await field.fill("");
      await field.focus();
      await page.keyboard.type(
        mode === "update" ? "fixture-password" : "fixture@example.invalid",
      );
      await browserExpect(field).not.toBeEmpty();
      if (mode !== "reset") {
        await page
          .getByRole("button", { name: "Show password", exact: true })
          .click();
        await browserExpect(
          page.getByLabel("Password", { exact: true }),
        ).toHaveAttribute("type", "text");
        await page
          .getByRole("button", { name: "Hide password", exact: true })
          .click();
      }
      await browserExpect(page.locator('button[type="submit"]')).toBeEnabled();
      await noOverflow();
      await page.screenshot({
        path: resolve(shots, `auth-${mode}-${width}.png`),
        fullPage: true,
      });
    }
  },
  60000,
);
it("disabled authentication allows keyboard entry without submitting to a provider", async () => {
  for (const mode of ["login", "register", "reset", "update"]) {
    await mount(mode, false);
    const field = page.getByLabel(
      mode === "update" ? "Password" : "Email address",
      { exact: true },
    );
    await field.fill("");
    await field.focus();
    await page.keyboard.type(
      mode === "update" ? "fixture-password" : "fixture@example.invalid",
    );
    await browserExpect(field).not.toBeEmpty();
    await browserExpect(page.locator('button[type="submit"]')).toBeDisabled();
  }
});
it("Overview file selection and prepared-file filters remain functional", async () => {
  await mount("overview");
  await browserExpect(page.getByLabel("Original file")).toBeEnabled();
  await page.getByLabel("Original file").setInputFiles({
    name: "selected.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("offline original"),
  });
  await browserExpect(
    page.getByRole("button", { name: "Prepare locally", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: resolve(shots, "overview-file-selected.png"),
    fullPage: true,
  });
  await mount("compress");
  await browserExpect(
    page.getByRole("button", { name: /fixture.txt/ }),
  ).toBeVisible();
  await page.getByLabel("Search local files").fill("no matching file");
  await browserExpect(
    page.getByRole("button", { name: /fixture.txt/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: /fixture.txt/ }).click();
  await browserExpect(
    page.getByRole("complementary", { name: "File details" }),
  ).toContainText("fixture.txt");
  await browserExpect(
    page.getByRole("link", { name: "Upload to Cloud", exact: true }),
  ).toHaveAttribute("href", /\/compress\?prepared=/);
  expect(await page.evaluate("transferHarness.stats().puts")).toBe(0);
});
it("existing upload picker and transfer feedback fit the redesigned workspace", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mount("compress");
  await page
    .getByRole("button", { name: "Upload to Cloud", exact: true })
    .click();
  await browserExpect(page.getByRole("dialog")).toContainText("fixture.txt");
  await noOverflow();
  await page.screenshot({
    path: resolve(shots, "prepared-picker-390.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByText("Prepared uploads on this device", { exact: true })
    .click();
  await page.evaluate("transferHarness.block('verify')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await page.waitForFunction("transferHarness.stats().reached==='verify'");
  await browserExpect(
    page.getByRole("progressbar", { name: "Verifying", exact: true }),
  ).toBeVisible();
  await noOverflow();
  await page.screenshot({
    path: resolve(shots, "transfer-verifying-390.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stop current transfer" }).click();
  await page.evaluate("transferHarness.release()");
});
it("navigation search and active styles are functional", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mount("files");
  await browserExpect(
    page.getByRole("link", { name: "My files", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Find a page").fill("Compress");
  await browserExpect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link"),
  ).toHaveCount(1);
  await browserExpect(
    page.getByRole("link", { name: "Compress", exact: true }),
  ).toBeVisible();
});
it("reference proportions keep cloud statistics above the fold and Auth aligned", async () => {
  await page.setViewportSize({ width: 1440, height: 941 });
  await mount("cloud");
  const geometry = await page
    .locator(".cloud-analytics .reference-panel")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { bottom: r.bottom, height: r.height };
      }),
    );
  expect(Math.max(...geometry.map((r) => r.bottom))).toBeLessThan(920);
  expect(Math.max(...geometry.map((r) => r.height))).toBeLessThan(350);
  expect(
    (await page.locator(".quota-card .storage-ring").boundingBox())?.width,
  ).toBeLessThanOrEqual(140);
  await page.setViewportSize({ width: 1440, height: 1028 });
  await mount("register");
  const input = await page.getByLabel("Email address").boundingBox();
  expect(input?.x).toBeGreaterThan(100);
  expect(input?.x).toBeLessThan(125);
  expect(input?.width).toBeGreaterThan(390);
  expect(input?.width).toBeLessThan(410);
  expect((await page.locator(".auth-visual").boundingBox())?.x).toBeGreaterThan(
    720,
  );
});
it("folder tiles, action menus and verified restore retain keyboard and save interaction", async () => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await mount("files");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Documents");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page
    .getByLabel("Actions for folder Documents", { exact: true })
    .click();
  await browserExpect(
    page.getByRole("button", { name: "Rename folder Documents" }),
  ).toBeVisible();
  await page
    .getByLabel("Actions for folder Documents", { exact: true })
    .click();
  await page.getByRole("button", { name: "Documents", exact: true }).focus();
  await page.keyboard.press("Enter");
  await browserExpect(page.getByText("This folder is empty.")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Folder breadcrumbs" })
    .getByRole("button", { name: "Root", exact: true })
    .click();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await browserExpect(
    page.getByRole("complementary", { name: "Selected file" }),
  ).toContainText("fixture.txt");
  expect(
    (
      await page
        .locator(".explorer-entries--list .explorer-entry")
        .first()
        .boundingBox()
    )?.height,
  ).toBeLessThanOrEqual(56);
  await browserExpect(
    page.getByRole("list", { name: "Folder contents" }),
  ).toHaveClass(/--list/);
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(shots, "restoration-390.png"),
    fullPage: true,
  });
  await noOverflow();
  await page.getByRole("button", { name: "Discard Restored Copy" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toHaveCount(0);
});
it("zero quota and empty analytics never imply stored files or invented activity", async () => {
  await page.evaluate("designHarness.emptyCloud()");
  await browserExpect(page.getByText("No cloud files yet")).toBeVisible();
  await browserExpect(
    page.getByText("No quota", { exact: true }),
  ).toBeVisible();
  await noOverflow();
});
it("authentication feedback is mocked and never contacts a provider", async () => {
  await mount("reset");
  await page.evaluate(
    "window.fetch=async()=>new Response('{}',{status:503,headers:{'Content-Type':'application/json'}})",
  );
  await page.getByLabel("Email address").fill("fixture@example.invalid");
  await page
    .getByRole("button", { name: "Send recovery instructions" })
    .click();
  await browserExpect(page.getByRole("status").last()).toContainText(
    "could not complete",
  );
});
it("unavailable account metadata stays unavailable rather than showing zero usage", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate("designHarness.unavailableOverview()");
  await browserExpect(
    page.getByText("Account quota could not be loaded."),
  ).toBeVisible();
  await browserExpect(
    page.getByText("Session status is unavailable."),
  ).toBeVisible();
  await browserExpect(
    page.getByText("Recent records could not be loaded."),
  ).toBeVisible();
  await browserExpect(page.locator(".storage-ring")).toHaveCount(0);
  await noOverflow();
  await page.screenshot({
    path: resolve(shots, "unavailable-overview-390.png"),
    fullPage: true,
  });
});
it("dark theme preserves layout and light remains the initial theme", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mount("cloud");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await browserExpect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await noOverflow();
  await page.screenshot({
    path: resolve(shots, "cloud-dark-1440.png"),
    fullPage: true,
  });
});

it.each([390, 768, 1024, 1440])(
  "account settings layout, active navigation and storage icon at %spx",
  async (width) => {
    await page.setViewportSize({ width, height: 1000 });
    await mount("account");
    await browserExpect(
      page.getByRole("heading", { name: "Account & security", exact: true }),
    ).toBeVisible();
    await browserExpect(
      page.getByText("fixture@example.invalid", { exact: true }),
    ).toBeVisible();
    await browserExpect(
      page.getByRole("link", { name: "Account settings", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await browserExpect(page.locator(".workspace-selector")).toBeVisible();
    await browserExpect(
      page.locator(".workspace-symbol .workspace-drive-icon"),
    ).toBeVisible();
    expect(
      (await page.locator(".workspace-symbol svg").boundingBox())?.width,
    ).toBe(20);
    expect(await page.locator("h1").textContent()).not.toContain("aaaaaaaa");
    await noOverflow();
    await mkdir(resolve(".cache/account-settings-screenshots"), {
      recursive: true,
    });
    await page.screenshot({
      path: resolve(
        ".cache/account-settings-screenshots",
        "account-" + width + ".png",
      ),
      fullPage: true,
    });
  },
);
it("account settings tablet navigation can reach both ends of the scroll strip", async () => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await mount("account");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const first = navigation.getByRole("link", { name: "Overview", exact: true });
  const last = navigation.getByRole("link", {
    name: "Development cloud storage",
    exact: true,
  });
  await browserExpect(first).toBeInViewport();
  await last.focus();
  await browserExpect(last).toBeInViewport();
  await first.focus();
  await browserExpect(first).toBeInViewport();
  await noOverflow();
});
it("account settings copy and password navigation use the supported actions", async () => {
  await mount("account");
  await page.evaluate(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedAccountId=text;}}})",
  );
  await page
    .getByRole("button", { name: "Copy account ID", exact: true })
    .click();
  await browserExpect(
    page.getByRole("status").filter({ hasText: "Account ID copied." }),
  ).toBeVisible();
  expect(await page.evaluate("window.copiedAccountId")).toBe(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  await browserExpect(
    page
      .getByRole("navigation", { name: "Account workspace links" })
      .getByRole("link", { name: "My files", exact: true }),
  ).toHaveAttribute("href", "/my-files");
  await browserExpect(
    page.getByRole("link", { name: "Open workspace", exact: true }),
  ).toHaveAttribute("href", "/app");
  await page.getByRole("link", { name: "Change password" }).click();
  await page.waitForURL("**/update-password");
});
it("account settings clipboard denial exposes a selectable fallback without claiming success", async () => {
  await mount("account");
  await page.evaluate(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}})",
  );
  await page
    .getByRole("button", { name: "Copy account ID", exact: true })
    .click();
  await browserExpect(page.getByLabel("Full account ID")).toHaveValue(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  await browserExpect(
    page.getByRole("status").filter({ hasText: "Clipboard unavailable." }),
  ).toBeVisible();
});
it.each([200, 503])(
  "account settings sign-out keeps session fencing and request behavior on HTTP %s",
  async (status) => {
    await mount("account");
    await page.evaluate(
      "window.logoutCalls=[];window.fetch=async(url,init)=>{window.logoutCalls.push({url,method:init.method,body:init.body});return await new Promise(resolve=>{window.finishLogout=resolve;});};window.sessionSignals=0;window.addEventListener('smart-storage-session-change',()=>window.sessionSignals++);",
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await browserExpect(
      page.getByRole("button", { name: /^Working/ }),
    ).toBeDisabled();
    expect(await page.evaluate("window.sessionSignals")).toBe(1);
    expect(await page.evaluate("window.logoutCalls")).toEqual([
      { url: "/api/auth/logout", method: "POST", body: "{}" },
    ]);
    await page.evaluate(
      'window.finishLogout(new Response("{}",{status:' + status + "}))",
    );
    if (status === 200) await page.waitForURL("**/login");
    else {
      await browserExpect(
        page
          .getByRole("status")
          .filter({ hasText: "The account request could not complete." }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/account");
      await browserExpect(
        page.getByRole("button", { name: "Sign out", exact: true }),
      ).toBeEnabled();
    }
  },
);
it("account settings loading, profile-unavailable and error states stay clear", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mount("account-loading");
  await browserExpect(page.getByRole("status")).toContainText(
    "Loading account details",
  );
  await noOverflow();
  await page.screenshot({
    path: resolve(".cache/account-settings-screenshots/loading-390.png"),
    fullPage: true,
  });
  await mount("account-error");
  await browserExpect(page.getByRole("alert")).toContainText(
    "Account details unavailable",
  );
  await noOverflow();
  await page.screenshot({
    path: resolve(".cache/account-settings-screenshots/error-390.png"),
    fullPage: true,
  });
  await mount("account", false);
  await browserExpect(
    page.getByText("Email unavailable", { exact: true }),
  ).toBeVisible();
  await browserExpect(
    page.getByRole("button", { name: "Copy account ID", exact: true }),
  ).toBeVisible();
});
