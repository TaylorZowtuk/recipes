import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AddRecipeScreen } from "./AddRecipeScreen";
import { CollectionScreen } from "./CollectionScreen";
import { RecipeScreen } from "./RecipeScreen";
import { Shell } from "./Shell";
import { SignInScreen } from "./SignInScreen";
import {
  FavoriteSitesScreen,
  FridgeScreen,
  KitchenSettingsScreen,
  WeekPlanScreen,
} from "./screens";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route path="recipes" element={<CollectionScreen />} />
          <Route path="recipes/:id/:slug?" element={<RecipeScreen />} />
          <Route path="week" element={<WeekPlanScreen />} />
          <Route path="fridge" element={<FridgeScreen />} />
          <Route path="sites" element={<FavoriteSitesScreen />} />
          <Route path="sign-in" element={<SignInScreen />} />
          <Route path="add" element={<AddRecipeScreen />} />
          <Route path="kitchen-settings" element={<KitchenSettingsScreen />} />
          <Route path="*" element={<Navigate to="/recipes" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
