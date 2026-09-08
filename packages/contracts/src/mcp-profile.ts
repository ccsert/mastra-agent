import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

// This profile is shared by import and execution. No remote refs, regex execution,
// coercion or implicit defaults are permitted for imported third-party schemas.
export function compileMcpSchema(schema: Record<string, unknown>) {
  if (schema.type !== "object" || JSON.stringify(schema).length > 16000)
    throw new Error("MCP_SCHEMA_UNSUPPORTED");
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 2000 || depth > 20) throw new Error("MCP_SCHEMA_UNSUPPORTED");
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  const checkKeywords = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          "$ref",
          "$dynamicRef",
          "$recursiveRef",
          "$async",
          "pattern",
          "patternProperties",
          "format",
        ].includes(key)
      )
        throw new Error("MCP_SCHEMA_UNSUPPORTED");
      if (
        ["properties", "$defs", "definitions", "dependentSchemas", "dependencies"].includes(key) &&
        child &&
        typeof child === "object"
      )
        for (const nested of Object.values(child)) checkKeywords(nested);
      else if (
        ["allOf", "anyOf", "oneOf", "prefixItems", "items"].includes(key) &&
        Array.isArray(child)
      )
        child.forEach(checkKeywords);
      else if (
        [
          "items",
          "contains",
          "additionalProperties",
          "additionalItems",
          "unevaluatedProperties",
          "unevaluatedItems",
          "propertyNames",
          "not",
          "if",
          "then",
          "else",
        ].includes(key)
      )
        checkKeywords(child);
    }
  };
  visit(schema, 0);
  checkKeywords(schema);
  const options = {
    strict: false,
    addUsedSchema: false,
    allErrors: false,
    ownProperties: true,
  };
  const validator =
    schema.$schema === "http://json-schema.org/draft-07/schema#"
      ? new Ajv(options)
      : new Ajv2020(options);
  return validator.compile(schema);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
