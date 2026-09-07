import test from "node:test";
import assert from "node:assert/strict";
import { storefrontFromAcceptLanguage } from "./app.js";

test("extracts region subtag from the first tag", () => {
  assert.equal(storefrontFromAcceptLanguage("he-IL,he;q=0.9,en-US;q=0.8"), "IL");
});

test("returns null when no tag has a region subtag", () => {
  assert.equal(storefrontFromAcceptLanguage("he,en;q=0.8"), null);
});

test("returns null when header is missing", () => {
  assert.equal(storefrontFromAcceptLanguage(undefined), null);
});

test("honors q-priority over tag order", () => {
  assert.equal(storefrontFromAcceptLanguage("en;q=0.5,he-IL;q=0.9"), "IL");
});
