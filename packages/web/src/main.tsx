import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { storedTheme } from "./state/ui.ts";
import "./styles.css";

// before the first render, so a remembered light theme never flashes dark
document.documentElement.setAttribute("data-theme", storedTheme());

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
