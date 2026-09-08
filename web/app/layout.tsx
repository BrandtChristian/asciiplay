import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const DESCRIPTION =
  "Play video as coloured ASCII art, in your browser and in your terminal. Drop a file in and it renders locally: nothing is uploaded.";

// Vercel supplies the production host at build time. The fallback only matters locally, where
// nothing reads an absolute URL anyway.
const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "asciiplay",
  description: DESCRIPTION,
  applicationName: "asciiplay",
  keywords: ["ascii art", "ascii video", "terminal", "video player", "ffmpeg", "rust"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "asciiplay",
    url: "/",
    title: "asciiplay",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "asciiplay",
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport = {
  themeColor: "#0a0806",
  colorScheme: "dark" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={plexMono.variable}>
      <body>{children}</body>
    </html>
  );
}
