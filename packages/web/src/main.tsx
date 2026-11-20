import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applySkin, initialSkin } from "./skins/index.ts";
import { storedTheme } from "./state/ui.ts";
import { storedMotionOff } from "./ui/motion.ts";

// before the first render, so a remembered light theme never flashes dark and the skin's font
// stylesheet is in before anything is drawn or measured (index.html already shows the chosen skin)
document.documentElement.setAttribute("data-theme", storedTheme());
document.documentElement.dataset.motion = storedMotionOff() ? "off" : "on";

applySkin(initialSkin()).finally(() => {
	createRoot(document.getElementById("root") as HTMLElement).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
});
