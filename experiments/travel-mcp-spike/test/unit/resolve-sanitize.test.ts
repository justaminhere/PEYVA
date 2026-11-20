import { expect, test } from "bun:test";
import { confirmFlytodayAirport, confirmMrbilitFlightCode, pickFlytodayHotelCity, pickMrbilitHotelCity } from "../../src/resolve.ts";
import { redactText, redactValue } from "../../src/sanitize.ts";

test("flight codes are confirmed only when the provider lists them", () => {
  const mb = { airports: [{ code: "THR", city: "تهران", airport: "مهرآباد" }, { code: "IKA" }], cities: [] };
  expect(confirmMrbilitFlightCode(mb, "THR")).toBe("THR");
  expect(confirmMrbilitFlightCode(mb, "KIH")).toBeNull();
  const ft = { places: [{ code: "KIH", name: "Kish", airports: [{ code: "KIH" }] }] };
  expect(confirmFlytodayAirport(ft, "KIH")).toBe("KIH");
  expect(confirmFlytodayAirport({ places: [] }, "KIH")).toBeNull();
});

test("hotel city is picked only when exactly one match exists", () => {
  expect(pickMrbilitHotelCity({ cities: [{ name: "کیش", slug: "kish" }] }, ["کیش"])).toBe("kish");
  expect(pickMrbilitHotelCity({ cities: [{ name: "کیش", slug: "kish" }, { name: "کیش ۲", slug: "kish2" }] }, ["کیش"])).toBeNull();
  expect(pickFlytodayHotelCity({ hotels: [{ kind: "city", city_id: 5, name_fa: "کیش" }, { kind: "hotel", city_id: 5, name_fa: "هتل کیش" }] }, ["کیش"])).toBe(5);
});

test("secrets are redacted from raw output", () => {
  expect(redactText("http://user:pa55@proxy:8080")).toBe("http://***:***@proxy:8080");
  expect(redactValue({ token: "x", international: false, nested: { cookie: "c" } }))
    .toEqual({ token: "***redacted***", international: false, nested: { cookie: "***redacted***" } });
});
