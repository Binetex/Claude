import { describe, it, expect } from "vitest";
import { decideReassignment } from "./reassignment";

describe("decideReassignment", () => {
  it("неинициированный draft → DELETE_AND_RECREATE", () => {
    expect(decideReassignment("DRAFT_CREATED")).toEqual({ action: "DELETE_AND_RECREATE" });
    expect(decideReassignment("DRAFT_PENDING")).toEqual({ action: "DELETE_AND_RECREATE" });
  });

  it("инициированный/активный draft → FLAG_PROBLEM draft_initiated", () => {
    for (const s of ["SCHEDULED", "COURIER_ASSIGNED", "PICKED_UP", "IN_TRANSIT"] as const) {
      expect(decideReassignment(s)).toEqual({ action: "FLAG_PROBLEM", reason: "draft_initiated" });
    }
  });

  it("терминальный → FLAG_PROBLEM terminal (ручное решение)", () => {
    for (const s of ["DELIVERED", "CANCELLED", "RETURNED", "FAILED"] as const) {
      expect(decideReassignment(s)).toEqual({ action: "FLAG_PROBLEM", reason: "terminal" });
    }
  });
});
