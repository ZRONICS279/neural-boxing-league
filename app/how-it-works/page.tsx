import type { Metadata } from "next";
import { HowItWorks } from "../how-it-works-page";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How the fighters in Forge League think, learn and get better: one neural network per athlete, a coach in the corner, and a career that carries forward.",
};


export default function HowItWorksPage() {
  return <HowItWorks />;
}
