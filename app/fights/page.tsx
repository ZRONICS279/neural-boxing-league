import type { Metadata } from "next";
import { PastFightsPage } from "../past-fights";

export const metadata: Metadata = {
  title: "Past fights",
  description:
    "Every bout Forge League has finished: who won, how, and a rewatch of the fight itself.",
};

export default function PastFights() {
  return <PastFightsPage />;
}
