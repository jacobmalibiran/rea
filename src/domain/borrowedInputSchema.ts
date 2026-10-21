import { z } from "zod";

/**
 * Borrow a required value unparsed until its owner admits it, while advertising
 * `advertised` in JSON Schema. Zod clones drop a patched projection, so it
 * lives on a private inner schema that describing or refining the result keeps.
 */
export const borrowedInputSchema = (
  advertised: z.ZodType,
): z.ZodNonOptional<z.ZodUnknown> => {
  const projection = z.unknown();
  projection._zod.processJSONSchema = advertised._zod.processJSONSchema;
  return projection.nonoptional();
};
