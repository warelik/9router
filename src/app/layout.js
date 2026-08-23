import { connection } from "next/server";
import { Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";
import { readBlabsFlags } from "@/lib/blabs/flags";
import { getDisplayBrand } from "@/lib/blabs/brandConfig";
import { BlabsModeProvider } from "@/lib/blabs/BlabsModeContext";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export async function generateMetadata() {
  await connection();
  const brand = getDisplayBrand(readBlabsFlags());
  return { title: brand.htmlTitle, description: brand.description, icons: { icon: brand.faviconHref } };
}

export async function generateViewport() {
  await connection();
  return { themeColor: getDisplayBrand(readBlabsFlags()).themeColor };
}

export default async function RootLayout({ children }) {
  await connection();
  const flags = readBlabsFlags();
  const brand = getDisplayBrand(flags);
  const value = { rebrand: flags.rebrand, demoLock: flags.demoLock, brand };
  return (
    <html lang="en" suppressHydrationWarning className={flags.rebrand ? "blabs-rebrand" : undefined} data-blabs-rebrand={flags.rebrand ? "1" : undefined} data-blabs-demo-lock={flags.demoLock ? "1" : undefined}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){document.documentElement.classList.add('fonts-loaded')})}else{document.documentElement.classList.add('fonts-loaded')}`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <BlabsModeProvider value={value}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
        </BlabsModeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
