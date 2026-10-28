export type ThemeName = "light" | "dark";

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function applyTheme(next: ThemeName) {
  document.documentElement.dataset.theme = next === "dark" ? "dark" : "";
  localStorage.setItem("fx-theme", next);
}
