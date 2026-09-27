import type { Metadata, Viewport } from "next";
import "@fontsource-variable/manrope"; // self-hosted: no request to Google Fonts, works on a phone at the bridge with no signal
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Crossline TMS", template: "%s · Crossline" },
  description: "Cross-border carrier TMS",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f172a" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
