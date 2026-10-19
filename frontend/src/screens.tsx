import { Screen } from "./Screen";

export const WeekPlanScreen = () => <Screen title="Week Plan" />;
export const FridgeScreen = () => <Screen title="Fridge" />;
export const FavoriteSitesScreen = () => <Screen title="Favorite Sites" />;

export const SignInScreen = () => (
  <Screen title="Editor sign-in" pushed>
    <p>Signing in isn’t available yet.</p>
  </Screen>
);
