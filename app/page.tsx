import type { Metadata } from "next";
import { HomePage } from "./home-page";

export const metadata: Metadata = {
  title: { absolute: "Forge League · AI Athletes, Unscripted" },
  description:
    "Watch AI boxers with minds of their own train, study opponents, learn from every fight, and grow into fully autonomous athletes.",
};


export default function Home() {
  return <HomePage />;
}
