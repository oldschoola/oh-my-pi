import { createApiKeyLogin } from "./api-key-login";

export const loginCliproxy = createApiKeyLogin({
	providerLabel: "CLIProxy",
	authUrl: "https://github.com/router-for-me/CLIProxyAPI",
	instructions:
		"Paste the API key you configured in your CLIProxyAPI `api-keys:` list. Set CLIPROXY_BASE_URL to override the default http://127.0.0.1:8317/v1 endpoint.",
	promptMessage: "Paste your CLIProxy API key",
	placeholder: "sk-...",
	validation: null,
});
