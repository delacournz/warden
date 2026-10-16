/**
 * uiautomator dump fixtures for the parser tests (pure data, no I/O).
 *
 * REAL: captured from a warden emulator (Pixel 10 AVD, 1080x2424) running the Expo dev launcher of the
 * delacour UI playground app: `adb exec-out uiautomator dump /dev/tty` (the `/dev/stdout` form printed
 * only the trailer on that image). Contains EditText, ScrollView, Button, ImageView and Compose
 * clickable `android.view.View` nodes.
 */
export const REAL_DEV_LAUNCHER_SCREEN = { width: 1080, height: 2424 };

export const REAL_DEV_LAUNCHER_DUMP =
	'<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?>\n<hierarchy rotation="0">\n<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="1" hint="">\n<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="2" hint="">\n<node index="0" text="" resource-id="nz.co.delacour.ui.playground:id/action_bar_root" class="android.widget.LinearLayout" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="1" hint="">\n<node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="2" hint="">\n<node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="1" hint="">\n<node index="0" text="" resource-id="" class="androidx.compose.ui.platform.ComposeView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="1" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2206]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,142][1080,2206]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[58,200][184,326]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[58,200][184,326]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.widget.ImageView" package="nz.co.delacour.ui.playground" content-desc="App Icon" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[63,205][179,321]" drawing-order="0" hint="" />\n</node>\n</node>\n<node index="1" text="Delacour UI" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[221,210][449,261]" drawing-order="1" hint="" />\n<node index="2" text="Development Build" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[221,272][526,317]" drawing-order="2" hint="" />\n<node index="3" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[896,200][1022,326]" drawing-order="3" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[896,200][1022,326]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="User" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[928,232][991,295]" drawing-order="0" hint="" />\n<node index="1" text="" resource-id="" class="android.widget.Button" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[901,205][1017,321]" drawing-order="1" hint="" />\n</node>\n</node>\n<node index="4" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[63,384][1017,1739]" drawing-order="4" hint="">\n<node index="0" text="" resource-id="" class="android.widget.ScrollView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[63,489][1017,1634]" drawing-order="0" hint="">\n<node index="0" text="DEVELOPMENT SERVERS" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[63,489][424,530]" drawing-order="0" hint="" />\n<node index="1" text="INFO" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[916,447][1042,573]" drawing-order="1" hint="" />\n<node index="2" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[63,572][1017,1529]" drawing-order="2" hint="">\n<node index="0" text="Start a local development server with:" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,614][634,653]" drawing-order="0" hint="" />\n<node index="1" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,695][975,827]" drawing-order="1" hint="">\n<node index="0" text="npx expo start" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[147,737][455,785]" drawing-order="0" hint="" />\n</node>\n<node index="2" text="Then, select the local server when it appears here." resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,869][809,908]" drawing-order="2" hint="" />\n<node index="3" text="" resource-id="" class="android.widget.EditText" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[147,951][933,1077]" drawing-order="3" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[147,951][933,1077]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[147,951][407,1077]" drawing-order="0" hint="" />\n<node index="1" text="http://" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[147,992][243,1035]" drawing-order="1" hint="" />\n</node>\n</node>\n<node index="4" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="false" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,1098][975,1227]" drawing-order="4" hint="">\n<node index="0" text="Connect" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[469,1140][612,1185]" drawing-order="0" hint="" />\n<node index="1" text="" resource-id="" class="android.widget.Button" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,1098][975,1227]" drawing-order="1" hint="" />\n</node>\n<node index="5" text="Or" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,1269][975,1308]" drawing-order="5" hint="" />\n<node index="6" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,1350][975,1487]" drawing-order="6" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,1350][975,1487]" drawing-order="0" hint="">\n<node index="0" text="Fetch development servers" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[147,1396][588,1441]" drawing-order="0" hint="" />\n<node index="1" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="Download" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[880,1392][933,1445]" drawing-order="1" hint="" />\n<node index="2" text="" resource-id="" class="android.widget.Button" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[105,1350][975,1487]" drawing-order="2" hint="" />\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n<node index="1" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[42,2206][1038,2361]" drawing-order="1" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="false" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[42,2206][346,2361]" drawing-order="0" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="Home" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[163,2227][226,2290]" drawing-order="0" hint="" />\n<node index="1" text="Home" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[152,2301][237,2340]" drawing-order="1" hint="" />\n</node>\n<node index="1" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[388,2206][692,2361]" drawing-order="1" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="Updates" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[509,2227][572,2290]" drawing-order="0" hint="" />\n<node index="1" text="Updates" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[481,2301][599,2340]" drawing-order="1" hint="" />\n</node>\n<node index="2" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[734,2206][1038,2361]" drawing-order="2" hint="">\n<node index="0" text="" resource-id="" class="android.view.View" package="nz.co.delacour.ui.playground" content-desc="Settings" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[855,2227][918,2290]" drawing-order="0" hint="" />\n<node index="1" text="Settings" resource-id="" class="android.widget.TextView" package="nz.co.delacour.ui.playground" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[828,2301][944,2340]" drawing-order="1" hint="" />\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</node>\n</hierarchy>';

/** One uiautomator `<node>`; every flag defaults to false except `enabled`. */
type NodeSpec = {
	cls: string;
	bounds: string;
	text?: string;
	id?: string;
	desc?: string;
	hint?: string;
	flags?: Partial<
		Record<
			"clickable" | "long-clickable" | "checkable" | "checked" | "scrollable" | "selected" | "password" | "focused",
			boolean
		>
	>;
	enabled?: boolean;
	children?: NodeSpec[];
};

function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/\n/g, "&#10;");
}

function renderNode(spec: NodeSpec, index: number): string {
	const f = spec.flags ?? {};
	const flag = (name: keyof typeof f) => (f[name] ? "true" : "false");
	const attrs =
		`index="${index}" text="${esc(spec.text ?? "")}" resource-id="${esc(spec.id ?? "")}" class="${spec.cls}" ` +
		`package="com.example.app" content-desc="${esc(spec.desc ?? "")}" checkable="${flag("checkable")}" ` +
		`checked="${flag("checked")}" clickable="${flag("clickable")}" enabled="${spec.enabled === false ? "false" : "true"}" ` +
		`focusable="true" focused="${flag("focused")}" scrollable="${flag("scrollable")}" long-clickable="${flag("long-clickable")}" ` +
		`password="${flag("password")}" selected="${flag("selected")}" bounds="${spec.bounds}" hint="${esc(spec.hint ?? "")}"`;
	if (!spec.children?.length) return `<node ${attrs} />`;
	return `<node ${attrs}>${spec.children.map(renderNode).join("")}</node>`;
}

export const SYNTHETIC_FORM_SCREEN = { width: 1080, height: 2400 };

/**
 * SYNTHETIC: a React Native style login form covering what the real capture lacks: RN `testID`
 * resource-ids (bare and `pkg:id/` prefixed), password EditText, CheckBox, Switch, SeekBar, RecyclerView,
 * a disabled button, an off-screen button, XML entities in text/content-desc, and a long-clickable row.
 * Ends with the `UI hierarchy dumped to:` trailer exactly as `uiautomator dump /dev/stdout` prints it.
 */
export const SYNTHETIC_FORM_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${renderNode(
	{
		cls: "android.widget.FrameLayout",
		bounds: "[0,0][1080,2400]",
		children: [
			{
				cls: "android.view.ViewGroup",
				bounds: "[0,0][1080,2400]",
				id: "com.example.app:id/root",
				children: [
					{ cls: "com.facebook.react.views.text.ReactTextView", bounds: "[60,100][1020,180]", text: "Sign in" },
					{
						cls: "android.widget.EditText",
						bounds: "[60,220][1020,340]",
						id: "email-input",
						text: "a@b.co",
						hint: "Email",
						flags: { clickable: true, "long-clickable": true, focused: true },
					},
					{
						cls: "android.widget.EditText",
						bounds: "[60,360][1020,480]",
						id: "password-input",
						text: "••••",
						flags: { clickable: true, password: true },
					},
					{
						cls: "android.widget.CheckBox",
						bounds: "[60,500][400,580]",
						id: "remember-me",
						text: "Remember me",
						flags: { clickable: true, checkable: true, checked: true },
					},
					{
						cls: "android.widget.Switch",
						bounds: "[600,500][1020,580]",
						id: "com.example.app:id/notifications",
						flags: { clickable: true, checkable: true },
					},
					{ cls: "android.widget.SeekBar", bounds: "[60,600][1020,680]", id: "volume", flags: { clickable: true } },
					{
						cls: "android.view.ViewGroup",
						bounds: "[60,700][1020,820]",
						id: "login-button",
						desc: 'Log in & "go" <now>\nplease',
						flags: { clickable: true },
						children: [{ cls: "android.widget.TextView", bounds: "[400,730][680,790]", text: "Log in" }],
					},
					{
						cls: "android.widget.Button",
						bounds: "[60,840][1020,940]",
						id: "disabled-button",
						text: "Disabled",
						enabled: false,
						flags: { clickable: true },
					},
					{
						cls: "androidx.recyclerview.widget.RecyclerView",
						bounds: "[0,1000][1080,2300]",
						id: "list",
						flags: { scrollable: true },
						children: [
							{
								cls: "android.view.ViewGroup",
								bounds: "[0,1000][1080,1200]",
								flags: { "long-clickable": true },
								children: [{ cls: "android.widget.TextView", bounds: "[40,1040][600,1100]", text: "Row one" }],
							},
							{ cls: "android.widget.TextView", bounds: "[40,1220][600,1280]", text: "Static footer" },
						],
					},
					{
						cls: "android.widget.ImageButton",
						bounds: "[0,2500][1080,2600]",
						id: "offscreen-fab",
						desc: "Off screen",
						flags: { clickable: true },
					},
					{ cls: "android.widget.ImageView", bounds: "[900,40][1020,90]", desc: "Logo" },
				],
			},
		],
	},
	0
)}</hierarchy>
UI hierarchy dumped to: /dev/stdout
`;
