import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FieldSpec,
  Mapper,
  Mapping,
  parseDate,
  parseDecimal,
  PendingLookup,
  TRANSFORMS,
} from "../src/mapping.js";
import { MappingError, ValidationError } from "../src/errors.js";

describe("Mapping module", () => {
  it("executes string transforms", () => {
    assert.equal(TRANSFORMS.trim!("  abc  "), "abc");
    assert.equal(TRANSFORMS.upper!("abc"), "ABC");
    assert.equal(TRANSFORMS.lower!("ABC"), "abc");
    assert.equal(TRANSFORMS.title!("hello world"), "Hello World");
    assert.equal(TRANSFORMS.capitalize!("hello world"), "Hello world");
    assert.equal(TRANSFORMS.collapse_spaces!("  hello   world  "), "hello world");
    assert.equal(TRANSFORMS.digits!("abc-123.456"), "123456");
    assert.equal(TRANSFORMS.digits_plus_prefix!("6281234"), "+6281234");
    assert.equal(TRANSFORMS.strip_zero_width!("\ufeffclean\u200b"), "clean");
  });

  it("parses decimals with comma and dot conventions", () => {
    assert.equal(parseDecimal("1,234.56"), "1234.56");
    assert.equal(parseDecimal("1.234,56"), "1234.56");
    assert.equal(parseDecimal("(500)"), "-500");
    assert.equal(parseDecimal("-42.5"), "-42.5");
    assert.equal(parseDecimal("1."), "1");
    assert.equal(parseDecimal("1e3"), "1000");
    assert.throws(() => parseDecimal("0x10"));
    assert.throws(() => parseDecimal("Infinity"));
  });

  it("parses dates and datetimes preserving day/month precedence and local time without timezone drift (H1 regression)", () => {
    const d1 = parseDate("2026-05-15");
    assert.equal(d1.getFullYear(), 2026);
    assert.equal(d1.getMonth(), 4);
    assert.equal(d1.getDate(), 15);

    const dNoSec = parseDate("2024-01-15 10:30");
    assert.equal(dNoSec.getFullYear(), 2024);
    assert.equal(dNoSec.getMonth(), 0);
    assert.equal(dNoSec.getDate(), 15);

    // Day/month precedence: 05/01/2024 must be 5th January, not May 1st!
    const mapperDate = new Mapper(
      Mapping.fromDict({
        fields: {
          Birth: { target: "BirthDate", type: "date" },
          CustomDate: { target: "CustomDate", type: "date", format: "%d-%b-%Y" },
          Created: { target: "CreatedOn", type: "datetime" },
          CreatedTz: { target: "CreatedWithTz", type: "datetime" },
        },
      })
    );

    const res1 = mapperDate.prepare({
      lineno: 2,
      values: {
        Birth: "05/01/2024",
        CustomDate: "05-Jan-2024",
        Created: "2024-01-31 08:15:00",
        CreatedTz: "2024-01-31T08:15:00+07:00",
      },
    });

    assert.equal(res1.payload.BirthDate, "2024-01-05");
    assert.equal(res1.payload.CustomDate, "2024-01-05");
    assert.equal(res1.payload.CreatedOn, "2024-01-31T08:15:00");
    assert.equal(res1.payload.CreatedWithTz, "2024-01-31T08:15:00+07:00");
  });

  it("handles mapping preparation and coercion", () => {
    const mapping = Mapping.fromDict({
      entity: "Contact",
      key_fields: ["Email"],
      constants: { ProcessListeners: 0 },
      fields: {
        "Full Name": { target: "Name", required: true, transform: "collapse_spaces" },
        "Email": { target: "Email", transform: "lower" },
        "Country": {
          target: "CountryId",
          type: "lookup",
          lookup: { entity: "Country", key_field: "Name" },
        },
      },
    });

    const mapper = new Mapper(mapping);
    const row = {
      lineno: 2,
      values: {
        "Full Name": "  John   Doe  ",
        "Email": "JOHN@EXAMPLE.COM",
        "Country": "Indonesia",
      },
    };

    const prep = mapper.prepare(row);
    assert.equal(prep.payload.Name, "John Doe");
    assert.equal(prep.payload.Email, "john@example.com");
    assert.equal(prep.payload.ProcessListeners, 0);
    assert.equal(prep.pending.length, 1);
    assert.equal(prep.pending[0]!.value, "Indonesia");

    // Finalize
    prep.pending[0]!.resolvedId = "11111111-2222-3333-4444-555555555555";
    const fin = mapper.finalize(prep);
    assert.equal(fin.payload.CountryId, "11111111-2222-3333-4444-555555555555");
    assert.equal(fin.keyValues.Email, "john@example.com");
  });

  it("instantiates pending lookup when default is defined on empty lookup field", () => {
    const mapping = Mapping.fromDict({
      entity: "Contact",
      fields: {
        "Country": {
          target: "CountryId",
          type: "lookup",
          default: "Indonesia",
          lookup: { entity: "Country", key_field: "Name" },
        },
      },
    });

    const mapper = new Mapper(mapping);
    const row = { lineno: 5, values: { Country: "" } };
    const prep = mapper.prepare(row);

    assert.equal(prep.pending.length, 1);
    assert.equal(prep.pending[0]!.value, "Indonesia");
  });

  it("fails when required fields are missing", () => {
    const mapping = Mapping.fromDict({
      entity: "Contact",
      fields: {
        "Name": { target: "Name", required: true },
      },
    });

    const mapper = new Mapper(mapping);
    assert.throws(() => mapper.prepare({ lineno: 1, values: { Name: "" } }), ValidationError);
  });

  it("validates key target fields", () => {
    assert.throws(
      () =>
        Mapping.fromDict({
          entity: "Contact",
          key_fields: ["NonExistentField"],
          fields: {
            Name: "Name",
          },
        }),
      MappingError
    );
  });
});
