import { z } from "zod";

/** Reusable zod input fragments so every tool across every server takes pagination and
 * verbosity the same way, per the collection's best-practice conventions. */
export const limitParam = (maxLimit: number, defaultLimit = 20) =>
  z
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .default(defaultLimit)
    .describe(`Max results to return (1-${maxLimit}, default ${defaultLimit}).`);

export const offsetParam = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of results to skip, for paging through a larger result set.");

export const responseFormatParam = z
  .enum(["concise", "detailed"])
  .default("concise")
  .describe("'concise' returns the fields a researcher typically needs; 'detailed' includes full metadata.");
