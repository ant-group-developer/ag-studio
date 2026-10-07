import { describe, expect, it } from "vitest";
import { RequirementsSchema } from "@ag-farm/protocol";
import { RENDER_MACHINES, renderRequirements } from "@harness/contracts";

// The farm's schema is strict: a key it does not know is a 400 at submit. This keeps Studio inside the contract.
describe("render machine requirements against the ag-farm contract", () => {
  for (const machine of RENDER_MACHINES) {
    it(`${machine}: the hub's RequirementsSchema accepts it unchanged`, () => {
      expect(RequirementsSchema.parse(renderRequirements(machine))).toEqual(renderRequirements(machine));
    });
  }
});
