import { Screen } from "./Screen";

export const FridgeScreen = () => <Screen title="Fridge" />;

export const KitchenSettingsScreen = () => (
  <Screen title="Kitchen settings" pushed>
    <p className="screen-note">
      Kitchen settings are coming soon: the Store Categories on the Grocery List, and their order.
    </p>
  </Screen>
);
