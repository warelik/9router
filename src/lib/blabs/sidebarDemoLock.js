// upstream/src/lib/blabs/sidebarDemoLock.js
export const SHOWROOM_NAV_ITEM = Object.freeze({
  href: "/dashboard/showroom",
  label: "Showroom",
  icon: "bar_chart",
});

export function shouldRestrictToShowroom(demoLock, statusPhase, role) {
  return demoLock && (statusPhase !== "ready" || role !== "admin");
}

export function selectSidebarNav(fullNav, demoLock, statusPhase, role) {
  return shouldRestrictToShowroom(demoLock, statusPhase, role)
    ? [SHOWROOM_NAV_ITEM]
    : fullNav;
}
