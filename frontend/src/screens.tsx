import { Screen } from "./Screen";

export const WeekPlanScreen = () => <Screen title="Week Plan" />;
export const FridgeScreen = () => <Screen title="Fridge" />;
export const FavoriteSitesScreen = () => <Screen title="Favorite Sites" />;

export const KitchenSettingsScreen = () => (
  <Screen title="Kitchen settings" pushed>
    <p className="screen-note">
      Kitchen settings are coming soon: the Store Categories on the Grocery List, and their order.
    </p>
  </Screen>
);
