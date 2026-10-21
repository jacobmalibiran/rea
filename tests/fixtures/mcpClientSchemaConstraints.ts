import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "../../src/contracts/jsonSchemaKeywords.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** VS Code Copilot rejects falsy `items` for any type that admits arrays. */
export const arrayItemSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  const admitsArrays =
    schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array"));
  if (admitsArrays && !schema.items)
    return `${path}: tool parameters array type must have items`;
  for (const [key, value] of Object.entries(schema)) {
    const children =
      schemaMaps.has(key) && isRecord(value)
        ? Object.entries(value).map(
            ([name, child]) => [`${key}.${name}`, child] as const,
          )
        : (schemaArrays.has(key) || schemaChildren.has(key)) &&
            Array.isArray(value)
          ? value.map(
              (child: unknown, index) => [`${key}.${index}`, child] as const,
            )
          : schemaChildren.has(key)
            ? [[key, value] as const]
            : [];
    for (const [suffix, child] of children) {
      const error = arrayItemSchemaError(child, `${path}.${suffix}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};

/** Reject Gemini-incompatible boolean literals in advertised input positions. */
export const booleanLiteralSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  if (typeof schema.const === "boolean") return `${path}.const is boolean`;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.some((value) => typeof value === "boolean")
  )
    return `${path}.enum contains a boolean`;
  for (const [key, value] of Object.entries(schema)) {
    const children =
      schemaMaps.has(key) && isRecord(value)
        ? Object.entries(value).map(
            ([name, child]) => [`${key}.${name}`, child] as const,
          )
        : schemaArrays.has(key) && Array.isArray(value)
          ? value.map(
              (child: unknown, index) => [`${key}[${index}]`, child] as const,
            )
          : schemaChildren.has(key)
            ? [[key, value] as const]
            : [];
    for (const [suffix, child] of children) {
      const error = booleanLiteralSchemaError(child, `${path}.${suffix}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};

/**
 * Claude's MCP client fills every advertised property default the caller
 * omitted, including inside nested objects, before the call reaches the
 * server. Return the arguments such a client sends for `value`.
 */
export const withAdvertisedDefaults = (
  schema: unknown,
  value: unknown,
): unknown => {
  if (!isRecord(schema)) return value;
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  const merged = members.reduce<unknown>(
    (current, member) => withAdvertisedDefaults(member, current),
    value,
  );
  if (Array.isArray(merged))
    return isRecord(schema.items)
      ? merged.map((item: unknown) =>
          withAdvertisedDefaults(schema.items, item),
        )
      : merged;
  const properties = schema.properties;
  if (!isRecord(merged) || !isRecord(properties)) return merged;
  const entries = Object.entries(merged).map(([name, child]) => [
    name,
    Object.hasOwn(properties, name)
      ? withAdvertisedDefaults(properties[name], child)
      : child,
  ]);
  for (const [name, child] of Object.entries(properties))
    if (
      !Object.hasOwn(merged, name) &&
      isRecord(child) &&
      child.default !== undefined
    )
      entries.push([
        name,
        withAdvertisedDefaults(child, structuredClone(child.default)),
      ]);
  return Object.fromEntries(entries);
};

/**
 * Claude Code presents a nested anyOf or oneOf as an empty schema, or as an
 * object without properties when every branch is an object, so callers lose
 * every field the union describes.
 */
export const nestedUnionSchemaErrors = (
  schema: unknown,
  path: string,
): readonly string[] => {
  if (Array.isArray(schema))
    return schema.flatMap((child: unknown, index) =>
      nestedUnionSchemaErrors(child, `${path}[${index}]`),
    );
  if (!isRecord(schema)) return [];
  return Object.entries(schema).flatMap(([key, value]) => {
    if (key === "anyOf" || key === "oneOf") return [`${path}.${key}`];
    if (schemaMaps.has(key) && isRecord(value))
      return Object.entries(value).flatMap(([name, child]) =>
        nestedUnionSchemaErrors(child, `${path}.${key}.${name}`),
      );
    if (schemaArrays.has(key) || schemaChildren.has(key))
      return nestedUnionSchemaErrors(value, `${path}.${key}`);
    return [];
  });
};
