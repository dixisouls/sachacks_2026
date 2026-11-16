import type { Metadata } from "next";
import { JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import Header from "@/components/Header";

const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Scaffold",
  description:
    "Name a disease. An AI designs three new molecules for it, live, and shows every attempt it threw out along the way.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${mono.variable} min-h-dvh font-sans antialiased`}>
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
