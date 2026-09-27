import type { Metadata } from "next";
import Shell from "@/components/Shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "PYROSENSE - Thermal Anomaly Command",
  description:
    "AI-based industrial thermal anomaly monitoring command dashboard.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full overflow-hidden font-body bg-bg-void text-text-primary antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
