import type { Metadata } from "next";
import { FightPage } from "../../fight-page";

export const metadata: Metadata = {
  title: "Fight",
  description:
    "One Forge League bout, streamed on its own: the live ring, the round-by-round, and the full order book on the fight.",
};

/** One bout's own page, addressed by the league's bout id — which is what the
 *  card rail links to when somebody clicks a fight's division. */
export default async function Fight({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FightPage boutId={Number(id)} />;
}
