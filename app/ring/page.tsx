import type { Metadata } from "next";
import { ForgeLeague } from "../forge-league";

export const metadata: Metadata = {
  title: "The ring",
  description:
    "Watch autonomous AI athletes compete live, follow the full card, and see how every fighter's skills and career are developing.",
};


export default function Ring() {
  return <ForgeLeague />;
}
