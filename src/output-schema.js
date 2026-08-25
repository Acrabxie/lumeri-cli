import { readFile } from "node:fs/promises";

import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export class OutputSchemaConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputSchemaConfigError";
  }
}

export class OutputSchemaMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputSchemaMismatchError";
  }
}

function dialectFor(schema) {
  const dialect = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema.$schema
    : null;
  if (dialect == null || dialect === "http://json-schema.org/draft-07/schema#") {
    return Ajv;
  }
  if (dialect === "https://json-schema.org/draft/2019-09/schema") return Ajv2019;
  if (dialect === "https://json-schema.org/draft/2020-12/schema") return Ajv2020;
  throw new OutputSchemaConfigError(`unsupported JSON Schema dialect: ${dialect}`);
}

export async function loadOutputSchema(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new OutputSchemaConfigError(`cannot read output schema ${filePath}: ${error.message}`);
  }

  let schema;
  try {
    schema = JSON.parse(source);
  } catch (error) {
    throw new OutputSchemaConfigError(`output schema ${filePath} is not valid JSON: ${error.message}`);
  }

  try {
    const AjvClass = dialectFor(schema);
    const ajv = new AjvClass({
      allErrors: true,
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
    });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    if (schema && typeof schema === "object" && schema.$async === true) {
      throw new OutputSchemaConfigError("asynchronous JSON Schemas are not supported");
    }
    return { schema, validate, ajv };
  } catch (error) {
    if (error instanceof OutputSchemaConfigError) throw error;
    throw new OutputSchemaConfigError(`output schema ${filePath} is invalid: ${error.message}`);
  }
}

export function validateOutputText(text, compiled) {
  let value;
  try {
    value = JSON.parse(String(text || "").trim());
  } catch (error) {
    throw new OutputSchemaMismatchError(`final response is not valid JSON: ${error.message}`);
  }

  const valid = compiled.validate(value);
  if (!valid) {
    const details = compiled.ajv.errorsText(compiled.validate.errors, { separator: "; " });
    throw new OutputSchemaMismatchError(`final response does not match output schema: ${details}`);
  }
  return value;
}
