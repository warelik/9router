let activeBrand = null;
export function setBlabsBrandify(brand) {
  activeBrand = brand?.hideUpstreamControls ? brand : null;
}
export function brandifyText(text, brand = activeBrand) {
  if (typeof text !== "string" || !brand?.hideUpstreamControls) return text;
  return text.replaceAll("9Router Proxy", brand.productName).replaceAll("9Router", brand.shortName).replaceAll("9router", brand.shortName);
}
