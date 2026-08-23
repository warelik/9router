import { APP_CONFIG } from "../../shared/constants/config.js";
export const UPSTREAM_DISPLAY_BRAND = Object.freeze({
  productName: APP_CONFIG.name, shortName: "9Router",
  htmlTitle: "9Router - AI Infrastructure Management",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  faviconHref: "/favicon.svg", icon192Href: "/icons/icon-192.svg", icon512Href: "/icons/icon-512.svg",
  themeColor: "#0a0a0a", manifestBackground: "#0a0a0a", hideUpstreamControls: false,
});
export const BLABS_DISPLAY_BRAND = Object.freeze({
  ...UPSTREAM_DISPLAY_BRAND, productName: "BLabsAIGate", shortName: "BLabsAIGate",
  htmlTitle: "BLabsAIGate - AI Infrastructure Management",
  faviconHref: "/blabs/favicon.svg", icon192Href: "/blabs/icons/icon-192.svg", icon512Href: "/blabs/icons/icon-512.svg",
  themeColor: "#0F766E", manifestBackground: "#0B1220", hideUpstreamControls: true,
});
export function getDisplayBrand(flags) {
  return flags.rebrand ? BLABS_DISPLAY_BRAND : UPSTREAM_DISPLAY_BRAND;
}
