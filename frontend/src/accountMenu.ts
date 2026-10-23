// What the account button's menu offers, by role.
export type AccountMenuItem = { label: string } & ({ to: string } | { action: "sign-out" });

export function accountMenuItems(isEditor: boolean): AccountMenuItem[] {
  const settings = { label: "Kitchen settings", to: "/kitchen-settings" };
  return isEditor
    ? [{ label: "Add a recipe", to: "/add" }, settings, { label: "Sign out", action: "sign-out" }]
    : [settings, { label: "Sign in", to: "/sign-in" }];
}
