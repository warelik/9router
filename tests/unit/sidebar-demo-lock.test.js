// upstream/tests/unit/sidebar-demo-lock.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  selectSidebarNav,
  shouldRestrictToShowroom,
} from "../../src/lib/blabs/sidebarDemoLock.js";

const fullNav = [
  { href: "/dashboard/endpoint" },
  { href: "/dashboard/usage" },
  { href: "/dashboard/quota" },
];
const hrefs = (demoLock, phase, role) =>
  selectSidebarNav(fullNav, demoLock, phase, role).map((item) => item.href);

it("sidebar_demo_lock_demo_role_shows_showroom_only", () => {
  expect(hrefs(true, "ready", "demo")).toEqual(["/dashboard/showroom"]);
});

it("sidebar_demo_lock_admin_role_shows_full_nav", () => {
  expect(hrefs(true, "ready", "admin")).toEqual(fullNav.map((item) => item.href));
  expect(hrefs(false, "loading", null)).toEqual(fullNav.map((item) => item.href));
});

it("sidebar_demo_lock_null_role_fail_closed_hides_restricted_nav", () => {
  expect(hrefs(true, "ready", null)).toEqual(["/dashboard/showroom"]);
});

it("sidebar_demo_lock_legacy_unroled_fail_closed_hides_restricted_nav", () => {
  expect(shouldRestrictToShowroom(true, "ready", undefined)).toBe(true);
});

it("sidebar_demo_lock_loading_fail_closed_hides_restricted_nav", () => {
  expect(hrefs(true, "loading", null)).toEqual(["/dashboard/showroom"]);
});

it("sidebar_demo_lock_error_fail_closed_hides_restricted_nav", () => {
  expect(hrefs(true, "error", null)).toEqual(["/dashboard/showroom"]);
});

it("login_demo_hint_insertion_only_no_d003_brand_line_edit", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const login = fs.readFileSync(path.join(here, "../../src/app/login/page.js"), "utf8");
  expect(login).toContain("Demo access: use the demo password");
  expect(login).toContain("useBlabsMode");
  expect(login).not.toMatch(/window\.__BLABS__|NEXT_PUBLIC_BLABS/);
  // D003-owned brand lines must survive (insertion-only; no deletion/replacement)
  expect(login).toMatch(/9Router|BLabsAIGate|brandifyText/);
  expect(login).toMatch(/Forgot password/);
  expect(login).toMatch(/CLI/);
});
