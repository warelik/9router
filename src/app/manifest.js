import { connection } from "next/server";
import { readBlabsFlags } from "@/lib/blabs/flags";
import { getDisplayBrand } from "@/lib/blabs/brandConfig";

export default async function manifest() {
  await connection();
  const brand = getDisplayBrand(readBlabsFlags());
  return {
    name: brand.htmlTitle,
    short_name: brand.shortName,
    description: brand.description,
    start_url: '/',
    display: 'standalone',
    background_color: brand.manifestBackground,
    theme_color: brand.themeColor,
    orientation: 'portrait-primary',
    icons: [
      {
        src: brand.icon192Href,
        sizes: '192x192',
        type: 'image/svg+xml',
      },
      {
        src: brand.icon512Href,
        sizes: '512x512',
        type: 'image/svg+xml',
      },
      {
        src: brand.icon512Href,
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  }
}
