import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { runtime } from "../integration/runtime";

const mf = await runtime();
const base = String(await mf.ready).replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox"],
  headless: true,
});
const errors: string[] = [];
async function newPlayer(name: string, invite?: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(invite ?? `${base}/blackjack/`);
  await page.getByLabel("Nickname").fill(name);
  await page
    .getByRole("button", {
      name: invite ? "Join table" : "Create table",
      exact: true,
    })
    .click();
  await page
    .locator(".connection")
    .filter({ hasText: /^connected$/ })
    .waitFor();
  return page;
}
async function copyInvite(page: Page): Promise<string> {
  await page
    .getByRole("button", { name: "Copy invite link", exact: true })
    .click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  return page.evaluate(() => navigator.clipboard.readText());
}
async function noOverflow(page: Page): Promise<void> {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Page must not overflow horizontally",
  );
}
async function waitForButton(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (n) =>
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent === n && !b.disabled,
      ),
    name,
  );
}
try {
  await mkdir("test-results", { recursive: true });
  const host = await newPlayer("Sanne");
  const invite = await copyInvite(host);
  assert.match(
    invite,
    /\/blackjack\/room\/[A-HJ-NP-Z2-9]{6}\?invite=[a-f0-9]{64}$/,
  );
  const friend = await newPlayer("Friend", invite);
  await host.locator(".seat").filter({ hasText: "Friend" }).waitFor();
  await host.getByLabel("Bet in chips").fill("100");
  await host.getByRole("button", { name: "Lock bet" }).click();
  await friend
    .locator(".seat")
    .filter({ hasText: "Sanne" })
    .getByText("Bet locked", { exact: true })
    .waitFor();
  await friend.getByLabel("Bet in chips").fill("50");
  await friend.getByRole("button", { name: "Lock bet" }).click();
  await waitForButton(host, "Deal cards");
  await host.getByRole("button", { name: "Deal cards" }).click();
  for (let count = 0; count < 15; count++) {
    if (
      await host
        .getByRole("button", { name: "Next round", exact: true })
        .count()
    )
      break;
    if (
      await host.getByRole("button", { name: "Stand", exact: true }).count()
    ) {
      await waitForButton(host, "Stand");
      await host.getByRole("button", { name: "Stand", exact: true }).click();
      await host
        .getByRole("button", { name: "Stand", exact: true })
        .waitFor({ state: "detached" });
    } else if (
      await friend.getByRole("button", { name: "Stand", exact: true }).count()
    ) {
      await waitForButton(friend, "Stand");
      await friend.getByRole("button", { name: "Stand", exact: true }).click();
      await friend
        .getByRole("button", { name: "Stand", exact: true })
        .waitFor({ state: "detached" });
    } else await host.waitForTimeout(100);
  }
  await host.getByRole("button", { name: "Next round", exact: true }).waitFor();
  assert.equal(await host.locator(".dealer .back").count(), 0);
  await host.screenshot({
    path: "test-results/table-desktop.png",
    fullPage: true,
  });
  await host.reload();
  await host
    .locator(".connection")
    .filter({ hasText: /^connected$/ })
    .waitFor();
  assert.equal(await host.locator(".seat").count(), 2);
  await host.getByRole("button", { name: "Leave", exact: true }).click();
  await friend
    .getByRole("button", { name: "Next round", exact: true })
    .waitFor();
  await friend.getByRole("button", { name: "Next round", exact: true }).click();
  await friend.setViewportSize({ width: 390, height: 844 });
  await friend.getByRole("button", { name: "Deal cards" }).waitFor();
  await noOverflow(friend);
  await friend.screenshot({
    path: "test-results/table-mobile.png",
    fullPage: true,
  });
  await friend.getByRole("button", { name: "Rules", exact: true }).click();
  assert.equal(await friend.locator("dialog[open]").count(), 1);
  await friend.keyboard.press("Escape");
  assert.equal(await friend.locator("dialog[open]").count(), 0);

  // Six-player desktop and mobile layouts, including long nicknames and hands.
  const sixHost = await newPlayer("Sanne");
  const sixInvite = await copyInvite(sixHost);
  const six = [sixHost];
  for (const name of ["Mila", "Noah", "This is a long nickname", "Sam", "Alex"])
    six.push(await newPlayer(name, sixInvite));
  await sixHost.waitForFunction(
    () => document.querySelectorAll(".seat").length === 6,
  );
  for (const page of six) {
    await page.getByRole("button", { name: "Lock bet" }).click();
    await page.getByRole("button", { name: "Change bet" }).waitFor();
  }
  await waitForButton(sixHost, "Deal cards");
  await sixHost.getByRole("button", { name: "Deal cards" }).click();
  await sixHost.locator(".playing-card").first().waitFor();
  await noOverflow(sixHost);
  await sixHost.screenshot({
    path: "test-results/table-six-desktop.png",
    fullPage: true,
  });
  await sixHost.setViewportSize({ width: 390, height: 844 });
  await noOverflow(sixHost);
  await sixHost.screenshot({
    path: "test-results/table-six-mobile.png",
    fullPage: true,
  });
  await sixHost.setViewportSize({ width: 320, height: 700 });
  await noOverflow(sixHost);

  const site = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  site.on("pageerror", (error) => errors.push(error.message));
  await site.goto(base);
  assert.equal(await site.locator("a").count(), 0);
  await site.screenshot({ path: "test-results/root.png" });
  await site.goto(`${base}/home/`);
  assert.equal(
    await site.locator('meta[name="robots"]').getAttribute("content"),
    "noindex,nofollow",
  );
  assert.ok((await site.locator("body").textContent())?.includes("Sanne"));
  await noOverflow(site);
  assert.ok(
    await site
      .locator("img")
      .evaluateAll((images) =>
        images.every(
          (image) =>
            (image as HTMLImageElement).complete &&
            (image as HTMLImageElement).naturalWidth > 0,
        ),
      ),
    "Personal homepage images must load",
  );
  await site.screenshot({
    path: "test-results/home-desktop.png",
    fullPage: true,
  });
  await site.setViewportSize({ width: 390, height: 844 });
  await noOverflow(site);
  await site.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
  });
  await site.goto(`${base}/blackjack/`);
  await site.screenshot({
    path: "test-results/lobby-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, [], "Browser must have no uncaught errors");
  console.log(
    "Browser checks passed: private invites, two-client round, refresh, host handover, rules, six seats, mobile layouts, homepage and images.",
  );
} finally {
  await browser.close();
  await mf.dispose();
}
