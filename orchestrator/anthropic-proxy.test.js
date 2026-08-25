"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { buildUpstreamHeaders } = require("./anthropic-proxy");

test("translates a Bearer token into x-api-key", () => {
  const headers = buildUpstreamHeaders({
    authorization: "Bearer sk-ant-api03-abc",
    "content-type": "application/json",
  });
  assert.equal(headers["x-api-key"], "sk-ant-api03-abc");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["content-type"], "application/json");
});

test("leaves an already-present x-api-key untouched and drops authorization", () => {
  const headers = buildUpstreamHeaders({
    authorization: "Bearer sk-ant-api03-wrong",
    "x-api-key": "sk-ant-api03-correct",
  });
  assert.equal(headers["x-api-key"], "sk-ant-api03-correct");
  assert.equal(headers.authorization, undefined);
});

test("passes a request with neither header through unchanged (minus stripped hop headers)", () => {
  const headers = buildUpstreamHeaders({ "anthropic-version": "2023-06-01" });
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-api-key"], undefined);
});

test("strips hop-specific headers that must never reach upstream verbatim", () => {
  const headers = buildUpstreamHeaders({
    host: "orchestrator:4004",
    "content-length": "42",
    authorization: "Bearer tok",
  });
  assert.equal(headers.host, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["x-api-key"], "tok");
});

test("a non-Bearer authorization value is left alone (not misparsed into x-api-key)", () => {
  const headers = buildUpstreamHeaders({ authorization: "Basic abc123" });
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.authorization, undefined); // still stripped — never forwarded raw
});
