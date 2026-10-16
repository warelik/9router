import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Current native GenerateContent documentation, verified 2026-10-06 via the
// explicit 127.0.0.1:18080 CONNECT proxy (HTTP 200 for both):
// https://ai.google.dev/gemini-api/docs/generate-content/structured-output
// https://ai.google.dev/api/generate-content
// REST TextResponseFormat.schema is a JSON Value: "The JSON schema that the
// output should conform to." These tests establish transport preservation,
// not backend enforcement of every possible keyword.

const MODEL = "gemini-3.5-flash-lite";
const credentials = {
  apiKey: "fixture-bridge-key",
  nativeGeminiPassthrough: true,
};
function opaqueSchema() {
  return {
    $id: "urn:fixture:opaque",
    $defs: { item: { type: "integer", enum: [3, 7], default: 3 } },
    type: "object",
    properties: {
      title: { type: "string", enum: ["KEEP_TITLE"], minLength: 1 },
      count: { $ref: "#/$defs/item" },
      tuple: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false },
      payload: { type: "object", default: { type: "customer", anyOf: "literal", responseJsonSchema: "literal" } },
    },
    required: ["title", "count"],
    additionalProperties: false,
    // Unknown future keywords/values are opaque at this boundary; existence
    // here does not claim backend support or enforcement.
    futureKeyword: { type: "customer", task: { args: [false, 3, { $ref: "literal-data" }] } },
  };
}
function body() {
  return {
    contents: [{ role: "user", parts: [{ text: "Return the structured output" }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: opaqueSchema(),
      maxOutputTokens: 2048,
      thinkingConfig: { thinking_level: "HIGH", include_thoughts: false },
      seed: 19,
      temperature: 0,
    },
    cachedContent: "cachedContents/fixture",
    tools: [{ functionDeclarations: [{ name: "task", parametersJsonSchema: { type: "object", additionalProperties: false } }] }],
    labels: { fixture: "fixed" },
  };
}
function transform(input, provider = "aistudio", creds = credentials, stream = false) {
  return new DefaultExecutor(provider).transformRequest(MODEL, input, stream, creds);
}

describe("AIStudio native modern structured output compatibility", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Request transform must not make network calls"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("moves the original schema opaquely without changing constraints, defaults, refs or literal values", () => {
    const input = body();
    const snapshot = structuredClone(input);
    const schema = input.generationConfig.responseJsonSchema;
    const output = transform(input);
    expect(output.generationConfig.responseFormat).toEqual({ text: { mimeType: "APPLICATION_JSON", schema } });
    expect(output.generationConfig.responseFormat.text.schema).toBe(schema);
    expect(output.generationConfig.responseFormat.text.schema).toEqual(snapshot.generationConfig.responseJsonSchema);
    expect(output.generationConfig.responseJsonSchema).toBeUndefined();
    expect(output.generationConfig.responseMimeType).toBeUndefined();
    const { responseJsonSchema, responseMimeType, ...settings } = snapshot.generationConfig;
    const { responseFormat, ...actualSettings } = output.generationConfig;
    expect(actualSettings).toEqual(settings);
    for (const name of ["contents", "tools", "cachedContent", "labels"]) expect(output[name]).toEqual(snapshot[name]);
    expect(input).toEqual(snapshot);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  for (const generationName of ["generationConfig", "generation_config"]) {
    for (const spelling of ["camel", "snake"]) {
      it(`accepts ${generationName} and ${spelling} schema/MIME names`, () => {
        const input = body();
        const settings = input.generationConfig;
        if (spelling === "snake") {
          settings.response_json_schema = settings.responseJsonSchema;
          settings.response_mime_type = settings.responseMimeType;
          delete settings.responseJsonSchema;
          delete settings.responseMimeType;
        }
        if (generationName === "generation_config") {
          input.generation_config = settings;
          delete input.generationConfig;
        }
        const snapshot = structuredClone(input);
        const output = transform(input);
        expect(output[generationName].responseFormat.text).toEqual({ mimeType: "APPLICATION_JSON", schema: opaqueSchema() });
        expect(output[generationName].maxOutputTokens).toBe(2048);
        expect(output[generationName].thinkingConfig).toEqual(settings.thinkingConfig);
        for (const name of ["responseJsonSchema", "response_json_schema", "responseMimeType", "response_mime_type"]) expect(output[generationName][name]).toBeUndefined();
        expect(input).toEqual(snapshot);
      });
    }
  }

  for (const schema of [true, false]) {
    it(`keeps a boolean JSON Schema (${schema}) opaque`, () => {
      const input = body();
      input.generationConfig.responseJsonSchema = schema;
      expect(transform(input).generationConfig.responseFormat.text.schema).toBe(schema);
    });
  }

  for (const key of ["responseFormat", "response_format", "responseSchema", "response_schema"]) {
    it(`does not merge or override an explicit conflicting ${key}`, () => {
      const input = body();
      input.generationConfig[key] = { text: { mimeType: "TEXT_PLAIN", schema: { type: "string" } }, future: { type: "literal" } };
      const snapshot = structuredClone(input);
      expect(transform(input)).toEqual(snapshot);
    });
  }

  it("does not choose between conflicting camel and snake schema aliases", () => {
    const input = body();
    input.generationConfig.response_json_schema = { type: "integer", minimum: 99 };
    const snapshot = structuredClone(input);
    expect(transform(input)).toEqual(snapshot);
    expect(input).toEqual(snapshot);
  });

  it("does not choose between conflicting camel and snake MIME aliases", () => {
    const input = body();
    input.generationConfig.response_mime_type = "text/plain";
    const snapshot = structuredClone(input);
    expect(transform(input)).toEqual(snapshot);
    expect(input).toEqual(snapshot);
  });

  it("leaves old responseSchema requests unchanged", () => {
    const input = body();
    input.generationConfig.responseSchema = { type: "OBJECT", properties: { count: { type: "INTEGER", minimum: 3, maximum: 3 } } };
    delete input.generationConfig.responseJsonSchema;
    const snapshot = structuredClone(input);
    expect(transform(input)).toEqual(snapshot);
  });

  it("leaves current responseFormat requests unchanged", () => {
    const input = body();
    input.generationConfig.responseFormat = { text: { mimeType: "APPLICATION_JSON", schema: opaqueSchema() }, audio: { future: "opaque" } };
    delete input.generationConfig.responseJsonSchema;
    delete input.generationConfig.responseMimeType;
    const snapshot = structuredClone(input);
    expect(transform(input)).toEqual(snapshot);
  });

  for (const mime of [undefined, "", null, "text/plain", "text/x.enum"]) {
    it(`does not invent JSON MIME for ${JSON.stringify(mime)}`, () => {
      const input = body();
      if (mime === undefined) delete input.generationConfig.responseMimeType;
      else input.generationConfig.responseMimeType = mime;
      const snapshot = structuredClone(input);
      expect(transform(input)).toEqual(snapshot);
    });
  }

  for (const provider of ["gemini", "openai"]) {
    it(`does not apply the AIStudio compatibility mapping to ${provider}`, () => {
      const input = body();
      const snapshot = structuredClone(input);
      expect(transform(input, provider)).toEqual(snapshot);
    });
  }

  it("does not alter already-translated client requests", () => {
    const input = body();
    const snapshot = structuredClone(input);
    expect(transform(input, "aistudio", { apiKey: "fixture-bridge-key" })).toEqual(snapshot);
  });

  it("emits a stable provider body across repetitions and streaming modes without network work", () => {
    const input = body();
    const executor = new DefaultExecutor("aistudio");
    const a = executor.transformRequest(MODEL, structuredClone(input), false, credentials);
    const b = executor.transformRequest(MODEL, structuredClone(input), true, credentials);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(executor.transformRequest(MODEL, structuredClone(input), false, credentials)));
    const headers = executor.buildHeaders(credentials, false, executor.buildUrl(MODEL, false, 0, credentials), MODEL, a);
    expect(headers["x-goog-api-key"]).toBe("fixture-bridge-key");
    expect(headers.Authorization).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
