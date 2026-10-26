import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = `localhost:${process.env.VCM_PORT ?? 8787}`;

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			"/api": `http://${server}`,
			"/ws": { target: `ws://${server}`, ws: true },
		},
	},
});
