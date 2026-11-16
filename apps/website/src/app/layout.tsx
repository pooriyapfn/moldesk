import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://moleculedesk.com"),
  title: "MoleculeDesk — Run molecular AI models locally",
  description:
    "MoleculeDesk is an open-source runtime for molecular AI models and workflows. Install models, build reproducible workflows with Claude Code or Codex, and run them locally or on cloud GPUs, all from one CLI.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "MoleculeDesk",
    title: "MoleculeDesk — Run molecular AI models locally",
    description: "MoleculeDesk is an open-source runtime for molecular AI models and workflows. Install models, build reproducible workflows with Claude Code or Codex, and run them locally or on cloud GPUs, all from one CLI.",
    url: "https://moleculedesk.com/",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const software = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "MoleculeDesk",
    url: "https://moleculedesk.com/",
    applicationCategory: "DeveloperApplication",
    description: "MoleculeDesk is an open-source runtime for molecular AI models and workflows. Install models, build reproducible workflows with Claude Code or Codex, and run them locally or on cloud GPUs, all from one CLI.",
    codeRepository: "https://github.com/pooriyapfn/moldesk",
  };
  return (
    <html
      lang="en"
      className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(software) }} />
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
