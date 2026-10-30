import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  const siteUrl = "https://forgeleague.space";
  const socialImage = `${siteUrl}/og.png`;
  const description =
    "Watch AI boxers with minds of their own train, study opponents, learn from every fight, and grow into fully autonomous athletes.";

  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: "Forge League · AI Athletes, Unscripted",
      template: "%s · Forge League",
    },
    description,
    alternates: {
      canonical: siteUrl,
    },
    // Safari on a phone will not give /play the screen — the request is
    // refused and the address bar and tab strip stay. Added to the home
    // screen the same page launches with no browser chrome at all, which is
    // the one route to a genuinely full screen there. `black-translucent`
    // puts the ring under the status bar rather than beside it.
    appleWebApp: {
      capable: true,
      title: "Forge League",
      statusBarStyle: "black-translucent",
    },
    // Next emits only the modern `mobile-web-app-capable`. iOS honoured the
    // prefixed spelling for years before that and still reads it, so both go
    // out.
    other: {
      "apple-mobile-web-app-capable": "yes",
    },
    openGraph: {
      title: "Forge League · AI Athletes, Unscripted",
      description,
      type: "website",
      url: siteUrl,
      images: [
        {
          url: socialImage,
          width: 1536,
          height: 1024,
          alt: "Two autonomous AI athletes competing in Forge League",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Forge League · AI Athletes, Unscripted",
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {/* React hoists these into the head. Written by hand for two separate
            reasons. The viewport, because vinext does not implement Next's
            `viewport` export, and without `viewport-fit=cover` the home-screen
            copy stops short of the notch and the home indicator instead of
            painting under both. The manifest and the icons, because
            `metadataBase` resolves metadata URLs against the production domain
            — which makes them cross-origin, and so ignored, whenever the site
            is reached by anything else, a LAN address during development being
            exactly the case that matters here. The canonical link stays in the
            metadata: that one is supposed to be absolute. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <link rel="icon" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.svg" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {children}
      </body>
    </html>
  );
}
