import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Shell } from "./Shell";
import {
  CollectionScreen,
  FavoriteSitesScreen,
  FridgeScreen,
  SignInScreen,
  WeekPlanScreen,
} from "./screens";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route path="recipes" element={<CollectionScreen />} />
          <Route path="week" element={<WeekPlanScreen />} />
          <Route path="fridge" element={<FridgeScreen />} />
          <Route path="sites" element={<FavoriteSitesScreen />} />
          <Route path="sign-in" element={<SignInScreen />} />
          <Route path="*" element={<Navigate to="/recipes" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
