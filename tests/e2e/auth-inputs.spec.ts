import { test, expect, type Locator } from "@playwright/test";

async function keyboardEdit(input: Locator, value: string) {
  await expect(input).toBeEnabled();
  await expect(input).not.toHaveAttribute("readonly", "");
  await input.focus();
  await expect(input).toBeFocused();
  await input.pressSequentially(value);
  await expect(input).toHaveValue(value);
  await input.press("End");
  await input.press("Backspace");
  await expect(input).toHaveValue(value.slice(0, -1));
  await input.pressSequentially(value.at(-1)!);
  await expect(input).toHaveValue(value);
}

test("login fields accept real keyboard input and remain masked where required", async ({
  page,
}) => {
  await page.goto("/login");
  await keyboardEdit(page.getByLabel("Email address"), "login@example.test");
  const password = page.getByLabel("Password");
  await keyboardEdit(password, "Login-secret-123");
  await expect(password).toHaveAttribute("type", "password");
});

test("signup fields accept keyboard edits and tab focus order", async ({
  page,
}) => {
  await page.goto("/register");
  const email = page.getByLabel("Email address");
  const password = page.getByLabel("Password", { exact: true });
  const confirmation = page.getByLabel("Confirm password");
  await keyboardEdit(email, "signup@example.test");
  await email.focus();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await keyboardEdit(password, "Signup-secret-123");
  await keyboardEdit(confirmation, "Signup-secret-123");
  await expect(password).toHaveAttribute("type", "password");
  await expect(confirmation).toHaveAttribute("type", "password");
});

test("forgot-password email accepts keyboard input without submitting", async ({
  page,
}) => {
  await page.goto("/forgot-password");
  await keyboardEdit(page.getByLabel("Email address"), "recovery@example.test");
  await expect(
    page.getByRole("button", { name: "Send recovery instructions" }),
  ).toBeDisabled();
});

test("password-update fields accept keyboard input and remain masked", async ({
  page,
}) => {
  await page.goto("/update-password");
  const password = page.getByLabel("Password", { exact: true });
  const confirmation = page.getByLabel("Confirm password");
  await keyboardEdit(password, "Updated-secret-123");
  await keyboardEdit(confirmation, "Updated-secret-123");
  await expect(password).toHaveAttribute("type", "password");
  await expect(confirmation).toHaveAttribute("type", "password");
});
