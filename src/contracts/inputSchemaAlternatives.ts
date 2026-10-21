import { isDeepStrictEqual } from "node:util";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredProperties = (
  branch: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Array.isArray(branch.required)
    ? branch.required.filter((name) => typeof name === "string")
    : [];

const preserveSharedDefault = (
  schema: Record<string, unknown>,
  branches: readonly unknown[],
): void => {
  if (schema.default !== undefined) return;
  const defaults = branches
    .filter(isObject)
    .map((branch) => branch.default)
    .filter((value) => value !== undefined);
  if (
    defaults.length > 0 &&
    defaults.every((value) => isDeepStrictEqual(value, defaults[0]))
  )
    schema.default = defaults[0];
};

const uniqueValues = <Value>(values: readonly Value[]): Value[] =>
  values.reduce<Value[]>(
    (unique, value) =>
      unique.some((seen) => isDeepStrictEqual(seen, value))
        ? unique
        : [...unique, value],
    [],
  );

const INSTANCE_TYPE_ORDER = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];

const literalValues = (
  branch: Readonly<Record<string, unknown>>,
): readonly unknown[] | undefined => {
  if (Object.hasOwn(branch, "const")) return [branch.const];
  if (Array.isArray(branch.enum)) return branch.enum;
  return branch.type === "null" ? [null] : undefined;
};

const instanceType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

/** Instance types a branch admits; undefined admits every JSON value. */
const admittedTypes = (
  branch: Readonly<Record<string, unknown>>,
): ReadonlySet<string> | undefined => {
  if (typeof branch.type === "string") return new Set([branch.type]);
  if (Array.isArray(branch.type))
    return new Set(branch.type.filter((type) => typeof type === "string"));
  const literals = literalValues(branch);
  return literals === undefined
    ? undefined
    : new Set(literals.map(instanceType));
};

/** Type-specific validation keywords a merged alternative may keep. */
const TYPE_FAMILIES = [
  {
    types: ["string"],
    keywords: [
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "contentEncoding",
      "contentMediaType",
    ],
  },
  {
    types: ["number", "integer"],
    keywords: [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ],
  },
  {
    types: ["array"],
    keywords: [
      "minItems",
      "maxItems",
      "uniqueItems",
      "contains",
      "minContains",
      "maxContains",
    ],
  },
  {
    types: ["object"],
    keywords: ["maxProperties", "propertyNames", "patternProperties"],
  },
] as const;

const LOWER_BOUNDS = new Set([
  "minLength",
  "minimum",
  "minItems",
  "minContains",
]);
const UPPER_BOUNDS = new Set([
  "maxLength",
  "maximum",
  "maxItems",
  "maxContains",
  "maxProperties",
]);

/**
 * Keep a keyword only when every branch admitting its instance type
 * constrains it; a branch without it would otherwise lose accepted inputs.
 */
const mergeKeyword = (keyword: string, values: readonly unknown[]): unknown => {
  if (values.length === 0 || values.some((value) => value === undefined))
    return undefined;
  if (values.every((value) => typeof value === "number")) {
    if (LOWER_BOUNDS.has(keyword)) return Math.min(...values);
    if (UPPER_BOUNDS.has(keyword)) return Math.max(...values);
  }
  return values.every((value) => isDeepStrictEqual(value, values[0]))
    ? values[0]
    : undefined;
};

export type MergedAlternatives = {
  readonly schema: Record<string, unknown>;
  readonly notes: readonly string[];
};

const describeForm = (
  branch: Readonly<Record<string, unknown>>,
  types: ReadonlySet<string> | undefined,
): string => {
  const literals = literalValues(branch);
  if (literals !== undefined)
    return literals.map((value) => JSON.stringify(value)).join(" | ");
  const label = types === undefined ? "any value" : [...types].join(" or ");
  const pattern =
    typeof branch.pattern === "string" ? ` matching ${branch.pattern}` : "";
  const format = typeof branch.format === "string" ? ` (${branch.format})` : "";
  return `${label}${pattern}${format}`;
};

/** Merge equivalent-position schemas into one, widening where they differ. */
const mergeVariants = (variants: readonly unknown[]): unknown => {
  const unique = uniqueValues(variants);
  if (unique.length === 1) return unique[0];
  const merged = mergeAlternatives(unique);
  if (merged === undefined) return { anyOf: unique };
  const description = [
    typeof merged.schema.description === "string"
      ? merged.schema.description
      : undefined,
    ...merged.notes,
  ].filter((text) => text !== undefined);
  return description.length === 0
    ? merged.schema
    : { ...merged.schema, description: description.join(" ") };
};

type Branch = Readonly<Record<string, unknown>>;

const commonRequired = (objects: readonly Branch[]): readonly string[] => {
  const [first = [], ...others] = objects.map(requiredProperties);
  return first.filter((name) => others.every((names) => names.includes(name)));
};

const declaredField = (branch: unknown, name: string): unknown =>
  isObject(branch) &&
  isObject(branch.properties) &&
  Object.hasOwn(branch.properties, name)
    ? branch.properties[name]
    : undefined;

/** A property declared by one branch takes what the others admit for it. */
const propertyVariants = (
  objects: readonly Branch[],
  name: string,
): unknown[] =>
  objects.flatMap((branch) => {
    const declared = declaredField(branch, name);
    if (declared !== undefined) return [declared];
    if (branch.patternProperties !== undefined) return [{}];
    if (branch.additionalProperties === false) return [];
    return [branch.additionalProperties ?? {}];
  });

/**
 * Clients fill an advertised default into every omitted field, so a merged
 * field keeps one only when every alternative declares that same default.
 */
export const sharedFieldDefault = (
  objects: readonly Branch[],
  name: string,
): unknown => {
  const defaults = objects.map((branch) => {
    const declared = declaredField(branch, name);
    return isObject(declared) ? declared.default : undefined;
  });
  const [first] = defaults;
  return first !== undefined &&
    defaults.every((value) => isDeepStrictEqual(value, first))
    ? first
    : undefined;
};

export const withDefault = (schema: unknown, value: unknown): unknown => {
  if (!isObject(schema)) return schema;
  const { default: _variantDefault, ...rest } = schema;
  return value === undefined ? rest : { ...rest, default: value };
};

/** Literal values a field admits, or undefined when it admits other values. */
const fieldLiterals = (schema: unknown): readonly unknown[] | undefined => {
  if (!isObject(schema)) return undefined;
  const own = literalValues(schema);
  if (own !== undefined) return own;
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  const sets = alternatives?.map(fieldLiterals) ?? [];
  return sets.length > 0 && sets.every((set) => set !== undefined)
    ? uniqueValues(sets.flat())
    : undefined;
};

/** Required literal fields whose values tell alternatives apart. */
const discriminatorFields = (
  sources: readonly unknown[],
): ReadonlySet<string> => {
  const names = uniqueValues(
    sources.flatMap((source) =>
      isObject(source) ? requiredProperties(source) : [],
    ),
  );
  return new Set(
    names.filter((name) => {
      const sets = sources.map((source) =>
        fieldLiterals(declaredField(source, name)),
      );
      return (
        sets.some((set) => set !== undefined) &&
        sets.some((set) => !isDeepStrictEqual(set, sets[0]))
      );
    }),
  );
};

type InputGroup = {
  readonly fields: readonly string[];
  readonly literals: ReadonlyMap<string, readonly unknown[]>;
};

/** Whether an advertised field already lists exactly these values. */
const enumerates = (schema: unknown, values: readonly unknown[]): boolean => {
  if (!isObject(schema) || !Array.isArray(schema.enum)) return false;
  const listed: readonly unknown[] = schema.enum;
  return (
    listed.length === values.length &&
    values.every((value) =>
      listed.some((item) => isDeepStrictEqual(item, value)),
    )
  );
};

/**
 * Name a branch's fields, labeling discriminators with the canonical values
 * that select the branch; merging widens Boolean literals and some clients
 * hide `const`.
 */
const inputGroup = (
  branch: Branch,
  source: unknown,
  discriminators: ReadonlySet<string>,
): InputGroup => {
  const required = requiredProperties(branch);
  const optional = Object.keys(branch.properties ?? {})
    .filter((name) => !required.includes(name))
    .map((name) => `[${name}]`);
  const literals = new Map(
    required.flatMap((name) => {
      const values = discriminators.has(name)
        ? fieldLiterals(declaredField(source, name))
        : undefined;
      return values === undefined ? [] : [[name, values] as const];
    }),
  );
  return { fields: [...required, ...optional], literals };
};

/**
 * Join groups of one shape whose literals differ in at most one field. The
 * joined group stays exact because every other field keeps its values.
 */
const joinGroups = (
  left: InputGroup,
  right: InputGroup,
): InputGroup | undefined => {
  if (
    !isDeepStrictEqual(left.fields, right.fields) ||
    !isDeepStrictEqual([...left.literals.keys()], [...right.literals.keys()])
  )
    return undefined;
  const differing = [...left.literals].filter(
    ([name, values]) => !isDeepStrictEqual(values, right.literals.get(name)),
  );
  const [first, ...others] = differing;
  if (first === undefined) return left;
  if (others.length > 0) return undefined;
  const [name, values] = first;
  return {
    fields: left.fields,
    literals: new Map([
      ...left.literals,
      [name, uniqueValues([...values, ...(right.literals.get(name) ?? [])])],
    ]),
  };
};

const combineGroups = (
  groups: readonly InputGroup[],
): readonly InputGroup[] => {
  for (const [index, left] of groups.entries())
    for (const [offset, right] of groups.slice(index + 1).entries()) {
      const joined = joinGroups(left, right);
      if (joined === undefined) continue;
      const other = index + 1 + offset;
      return combineGroups(
        groups.flatMap((group, position) =>
          position === index ? [joined] : position === other ? [] : [group],
        ),
      );
    }
  return groups;
};

/** A label the merged field already lists exactly adds no guidance. */
const formatGroup = (
  { fields, literals }: InputGroup,
  merged: Readonly<Record<string, unknown>>,
): string =>
  fields
    .map((name) => {
      const values = literals.get(name);
      return values === undefined ||
        enumerates(
          Object.hasOwn(merged, name) ? merged[name] : undefined,
          values,
        )
        ? name
        : `${name}:${values.map((value) => JSON.stringify(value)).join("|")}`;
    })
    .join(" + ");

const mergeObjectAlternatives = (
  objects: readonly Branch[],
  sources: readonly unknown[],
  schema: Record<string, unknown>,
  notes: string[],
): void => {
  const names = uniqueValues(
    objects.flatMap((branch) =>
      isObject(branch.properties) ? Object.keys(branch.properties) : [],
    ),
  );
  const properties: Readonly<Record<string, unknown>> = Object.fromEntries(
    names.map((name) => [
      name,
      withDefault(
        mergeVariants(propertyVariants(objects, name)),
        sharedFieldDefault(objects, name),
      ),
    ]),
  );
  if (names.length > 0) schema.properties = properties;
  const required = commonRequired(objects);
  if (required.length > 0) schema.required = required;
  // Each branch's required fields bound its property count from below.
  const fewestProperties = Math.min(
    ...objects.map((branch) =>
      Math.max(
        typeof branch.minProperties === "number" ? branch.minProperties : 0,
        requiredProperties(branch).length,
      ),
    ),
  );
  if (fewestProperties > 0) schema.minProperties = fewestProperties;
  const additional = objects.map(
    (branch) => branch.additionalProperties ?? true,
  );
  if (additional.every((value) => value === false))
    schema.additionalProperties = false;
  else {
    const open = mergeVariants(
      additional
        .filter((value) => value !== false)
        .map((value) => (value === true ? {} : value)),
    );
    if (!isEmptySchema(open)) schema.additionalProperties = open;
  }
  // Groups that differ only in non-literal values add no caller guidance.
  const discriminators = discriminatorFields(sources);
  const groups = combineGroups(
    objects.flatMap((branch, index) =>
      isObject(branch.properties)
        ? [inputGroup(branch, sources[index], discriminators)]
        : [],
    ),
  );
  if (groups.length > 1)
    notes.push(
      `Provide a complete input group: ${groups
        .map((group) => formatGroup(group, properties))
        .join("; ")}.`,
    );
};

const isEmptySchema = (schema: unknown): boolean =>
  isObject(schema) && Object.keys(schema).length === 0;

// Draft 2020-12 spells tuples as prefixItems + items; draft-07 spells them
// as an items array + additionalItems.
const tuplePrefix = (branch: Branch): unknown =>
  Array.isArray(branch.items) ? branch.items : branch.prefixItems;
const tupleRest = (branch: Branch): unknown =>
  Array.isArray(branch.items) ? branch.additionalItems : branch.items;

const mergeArrayAlternatives = (
  arrays: readonly Branch[],
  schema: Record<string, unknown>,
): void => {
  const prefix = mergeKeyword("prefixItems", arrays.map(tuplePrefix));
  const remaining = arrays.flatMap((branch) => {
    const items = tupleRest(branch);
    const rest = items === false ? [] : [items ?? {}];
    // Without a shared prefix, every tuple position becomes an item form.
    const own = tuplePrefix(branch);
    if (prefix !== undefined || own === undefined) return rest;
    return Array.isArray(own) ? [...own, ...rest] : [{}];
  });
  const items = remaining.length === 0 ? {} : mergeVariants(remaining);
  if (prefix === undefined) {
    // Clients require an item schema for every array declaration.
    const declaresArray =
      schema.type === "array" ||
      (Array.isArray(schema.type) && schema.type.includes("array"));
    if (declaresArray || !isEmptySchema(items)) schema.items = items;
  } else if (arrays.some((branch) => Array.isArray(branch.items))) {
    schema.items = prefix;
    if (!isEmptySchema(items)) schema.additionalItems = items;
  } else {
    schema.prefixItems = prefix;
    schema.items = items;
  }
};

const mergeTypes = (
  typeSets: readonly (ReadonlySet<string> | undefined)[],
): string | string[] | undefined => {
  if (!typeSets.every((types) => types !== undefined)) return undefined;
  const types = new Set(typeSets.flatMap((admitted) => [...admitted]));
  if (types.has("number")) types.delete("integer");
  const ordered = INSTANCE_TYPE_ORDER.filter((type) => types.has(type));
  return ordered.length === 1 ? ordered[0] : ordered;
};

const mergeLiterals = (
  branches: readonly Branch[],
): readonly unknown[] | undefined => {
  const literalSets = branches.map(literalValues);
  if (!literalSets.every((values) => values !== undefined)) return undefined;
  const literals = uniqueValues(literalSets.flat());
  // Gemini rejects Boolean literals, so Boolean alternatives keep only types.
  return literals.some((value) => typeof value === "boolean")
    ? undefined
    : literals;
};

/** Name literal, pattern, and format alternatives one type cannot express. */
const acceptedFormsNote = (
  branches: readonly Branch[],
  typeSets: readonly (ReadonlySet<string> | undefined)[],
): string | undefined => {
  // An alternative that admits every value makes the other forms moot, and
  // object-only alternatives are described by their input groups instead.
  if (
    typeSets.some((types) => types === undefined) ||
    typeSets.every((types) => [...(types ?? [])].every((t) => t === "object"))
  )
    return undefined;
  const informative = branches.some(
    (branch) =>
      Object.hasOwn(branch, "const") ||
      Array.isArray(branch.enum) ||
      typeof branch.pattern === "string" ||
      typeof branch.format === "string",
  );
  const forms = uniqueValues(
    branches.map((branch, index) => describeForm(branch, typeSets[index])),
  );
  return informative && forms.length > 1
    ? `Accepted forms: ${forms.join("; ")}.`
    : undefined;
};

/**
 * Present alternatives as one schema that accepts every input any branch
 * accepts. Claude Code drops nested anyOf and oneOf, and Anthropic rejects
 * them at the root, so a union reaches those clients as an unconstrained
 * object. Merged guidance keeps the shared fields, literal values, and
 * input groups; the canonical Zod schema still enforces the exact branch.
 * `canonical` holds each alternative before advertisement normalization,
 * whose literals name the input groups.
 */
export const mergeAlternatives = (
  alternatives: readonly unknown[],
  canonical: readonly unknown[] = alternatives,
): MergedAlternatives | undefined => {
  // A false schema accepts nothing and contributes no accepted input.
  const kept = alternatives.flatMap((branch, index) =>
    branch === false ? [] : [index],
  );
  const branches = kept.map((index) => alternatives[index]);
  const sources = kept.map((index) => canonical[index]);
  if (branches.some((branch) => branch === true))
    return { schema: {}, notes: [] };
  if (branches.length === 0 || !branches.every(isObject)) return undefined;
  // Reference targets live outside this node, so their constraints cannot
  // be merged here without changing what the branch accepts.
  if (branches.some((branch) => typeof branch.$ref === "string"))
    return undefined;

  const typeSets = branches.map(admittedTypes);
  /** Select the entries, aligned with `branches`, that admit `types`. */
  const admitting = <Entry>(
    entries: readonly Entry[],
    types: readonly string[],
  ): Entry[] =>
    entries.filter((_, index) => {
      const admitted = typeSets[index];
      return admitted === undefined || types.some((type) => admitted.has(type));
    });
  const schema: Record<string, unknown> = {};
  const notes: string[] = [];

  const descriptions = uniqueValues(
    branches
      .map((branch) => branch.description)
      .filter((text) => typeof text === "string"),
  );
  if (descriptions.length === 1) schema.description = descriptions[0];
  preserveSharedDefault(schema, branches);
  const type = mergeTypes(typeSets);
  if (type !== undefined) schema.type = type;
  const literals = mergeLiterals(branches);
  if (literals !== undefined) schema.enum = literals;

  for (const family of TYPE_FAMILIES) {
    const members = admitting(branches, family.types);
    for (const keyword of family.keywords) {
      const merged = mergeKeyword(
        keyword,
        members.map((branch) => branch[keyword]),
      );
      if (merged !== undefined) schema[keyword] = merged;
    }
  }
  const objects = admitting(branches, ["object"]);
  if (objects.length > 0)
    mergeObjectAlternatives(
      objects,
      admitting(sources, ["object"]),
      schema,
      notes,
    );
  const arrays = admitting(branches, ["array"]);
  if (arrays.length > 0) mergeArrayAlternatives(arrays, schema);

  const forms =
    literals === undefined ? acceptedFormsNote(branches, typeSets) : undefined;
  if (forms !== undefined) notes.push(forms);
  return { schema, notes };
};

/**
 * Splice pure nested unions into their parent. The merge accepts every
 * branch input either way; a nested oneOf only widens to the outer union.
 */
export const unionBranches = (branches: readonly unknown[]): unknown[] =>
  branches.flatMap((branch) => {
    if (!isObject(branch)) return [branch];
    const {
      anyOf,
      oneOf,
      description: _description,
      title: _title,
      ...constraints
    } = branch;
    if (Object.keys(constraints).length > 0) return [branch];
    if (Array.isArray(anyOf) && oneOf === undefined)
      return unionBranches(anyOf);
    if (Array.isArray(oneOf) && anyOf === undefined)
      return unionBranches(oneOf);
    return [branch];
  });

/** Attach merged alternatives to the schema that declared them. */
export const attachAlternatives = (
  node: Record<string, unknown>,
  { schema, notes }: MergedAlternatives,
): void => {
  const { description, default: shared, ...validation } = schema;
  // Sibling keywords constrain the same instance; keep both on conflict.
  const conflict = Object.entries(validation).some(
    ([key, value]) =>
      Object.hasOwn(node, key) && !isDeepStrictEqual(node[key], value),
  );
  if (conflict)
    node.allOf = [...(Array.isArray(node.allOf) ? node.allOf : []), validation];
  else Object.assign(node, validation);
  if (node.default === undefined && shared !== undefined) node.default = shared;
  const text = [
    typeof node.description === "string" ? node.description : description,
    ...notes,
  ].filter((value) => typeof value === "string");
  if (text.length > 0) node.description = text.join(" ");
};
