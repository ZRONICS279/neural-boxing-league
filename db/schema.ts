import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const trainingJobs = sqliteTable("training_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  targetId: text("target_id").notNull(),
  leagueJson: text("league_json").notNull(),
  remainingCycles: integer("remaining_cycles"),
  cycles: integer("cycles").notNull().default(0),
  bouts: integer("bouts").notNull().default(0),
  physicsSteps: integer("physics_steps").notNull().default(0),
  candidates: integer("candidates").notNull().default(0),
  checkpoints: integer("checkpoints").notNull().default(0),
  startFitness: real("start_fitness").notNull().default(0),
  currentFitness: real("current_fitness").notNull().default(0),
  rewardGain: real("reward_gain").notNull().default(0),
  pauseRequested: integer("pause_requested", { mode: "boolean" })
    .notNull()
    .default(false),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
