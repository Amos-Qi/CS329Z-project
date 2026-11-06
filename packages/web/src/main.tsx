import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { storedTheme } from "./state/ui.ts";
import { storedMotionOff } from "./ui/motion.ts";
import "./styles.css";

// before the first render, so a remembered light theme never flashes dark
document.documentElement.setAttribute("data-theme", storedTheme());
document.documentElement.dataset.motion = storedMotionOff() ? "off" : "on";

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
