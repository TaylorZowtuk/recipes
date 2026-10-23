import { Link } from "react-router";
import { Screen } from "./Screen";
import { EditorOnly } from "./session";

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

export const AddRecipeScreen = () => (
  <Screen title="Add a recipe" pushed>
    <EditorOnly
      fallback={
        <div className="prompt">
          <p>Only the household’s editors can add recipes.</p>
          <Link to="/sign-in" className="button">
            Sign in
          </Link>
        </div>
      }
    >
      <p className="screen-note">Adding recipes is coming soon.</p>
    </EditorOnly>
  </Screen>
);
