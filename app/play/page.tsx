import type { Metadata } from "next";
import { PlayerFight } from "../player-fight";

export const metadata: Metadata = {
  title: "Play as a fighter",
  description:
    "Take a corner yourself and box a Forge League athlete under the same physics the live card runs on.",
};


export default function Play() {
  return <PlayerFight />;
}
