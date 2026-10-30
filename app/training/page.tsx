import type { Metadata } from "next";
import { TrainingLab } from "../training-lab";

export const metadata: Metadata = {
  title: "Training lab",
  description:
    "Watch the Forge League roster rotate through persistent autonomous sparring.",
};


export default function Training() {
  return <TrainingLab />;
}
