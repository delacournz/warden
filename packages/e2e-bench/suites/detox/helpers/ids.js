/** testIDs the specs address; mirrors apps/example/e2e/helpers/ids.ts. */
const ids = {
	welcome: {
		screen: "welcome-screen",
		title: "welcome-title",
		next: "welcome-next",
		getStarted: "welcome-get-started",
	},
	signIn: {
		screen: "sign-in-screen",
		email: "sign-in-email",
		password: "sign-in-password",
		submit: "sign-in-submit",
		emailError: "sign-in-email-error",
		passwordError: "sign-in-password-error",
		formError: "sign-in-error",
	},
	todos: {
		screen: "todos-screen",
		input: "todo-input",
		add: "todo-add",
		remaining: "todos-remaining",
		empty: "todos-empty",
		filter: (value) => `todos-filter-${value}`,
		row: (id) => `todo-row-${id}`,
		check: (id) => `todo-check-${id}`,
		title: (id) => `todo-title-${id}`,
	},
	detail: {
		screen: "todo-detail-screen",
		title: "todo-detail-title",
		status: "todo-detail-status",
		toggle: "todo-detail-toggle",
		remove: "todo-detail-delete",
		back: "todo-detail-back",
		missing: "todo-detail-missing",
	},
	settings: {
		screen: "settings-screen",
		email: "settings-email",
		notifications: "settings-notifications",
		darkMode: "settings-dark-mode",
		signOut: "settings-sign-out",
	},
	tabs: { todos: "tab-todos", settings: "tab-settings" },
};

module.exports = { ids };
