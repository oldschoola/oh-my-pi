/** Crof.ai login flow (API key paste, validated via /models). */
import { createApiKeyLogin } from "./api-key-login";

export const loginCrof = createApiKeyLogin({
	providerLabel: "Crof",
	authUrl: "https://crof.ai/",
	instructions: "Create or copy your Crof API key from https://crof.ai/account",
	promptMessage: "Paste your Crof API key",
	placeholder: "nahcrof_...",
	validation: {
		kind: "models-endpoint",
		provider: "Crof",
		modelsUrl: "https://crof.ai/v1/models",
	},
});
