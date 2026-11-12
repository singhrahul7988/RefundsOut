import { cookies } from "next/headers";

// Demo identities. Two people are needed to approve large runs, so the UI lets you switch between them.
export const USERS = {
  maya: { id: "maya", name: "Maya Chen", role: "operator" as const, initials: "MC" },
  jordan: { id: "jordan", name: "Jordan Ortiz", role: "approver" as const, initials: "JO" },
};
export type DemoUser = (typeof USERS)[keyof typeof USERS];

export async function currentUser(): Promise<DemoUser> {
  const id = (await cookies()).get("ro_user")?.value;
  return id === "jordan" ? USERS.jordan : USERS.maya;
}
