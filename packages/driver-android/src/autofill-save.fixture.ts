/**
 * Android autofill "Save password to Google Password Manager?" sheet, rebuilt from a uiautomator tree read off a real
 * Android 14 phone (GRAVITY G64, 720x1600) over the example app after a valid sign-in. Ids, classes and bounds are the
 * real ones; the saved username is a generic test address. Not a byte-for-byte dump: attributes uiautomator prints but
 * the parser ignores are fixed.
 */
export const AUTOFILL_SAVE_SCREEN = { width: 720, height: 1600 };

type Spec = { cls: string; bounds: string; id?: string; text?: string; clickable?: boolean; children?: Spec[] };

const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function render(spec: Spec, index: number): string {
	const attrs =
		`index="${index}" text="${esc(spec.text ?? "")}" resource-id="${spec.id ?? ""}" class="${spec.cls}" ` +
		`package="com.google.android.gms" content-desc="" checkable="false" checked="false" ` +
		`clickable="${spec.clickable === true}" enabled="true" focusable="${spec.clickable === true}" focused="false" ` +
		`scrollable="false" long-clickable="false" password="false" selected="false" bounds="${spec.bounds}"`;
	if (spec.children === undefined) return `<node ${attrs} />`;
	return `<node ${attrs}>${spec.children.map(render).join("")}</node>`;
}

const GROUP = "android.view.ViewGroup";
const TEXT = "android.widget.TextView";
const IMAGE = "android.widget.ImageView";
const BUTTON = "android.widget.Button";
const pkg = (id: string): string => `com.google.android.gms:id/${id}`;

const tree: Spec = {
	cls: GROUP,
	bounds: "[0,331][720,1504]",
	children: [
		{
			cls: GROUP,
			bounds: "[48,379][672,1504]",
			id: pkg("autofill_save"),
			children: [
				{
					cls: GROUP,
					bounds: "[48,379][672,1308]",
					children: [
						{ cls: IMAGE, bounds: "[48,379][672,491]", id: pkg("autofill_save_icon") },
						{
							cls: TEXT,
							bounds: "[48,523][672,693]",
							id: pkg("autofill_save_title"),
							text: "Save password to Google Password Manager?",
						},
						{
							cls: GROUP,
							bounds: "[48,693][672,1308]",
							id: pkg("autofill_save_custom_subtitle"),
							children: [
								{
									cls: GROUP,
									bounds: "[48,693][672,1308]",
									id: pkg("save_credential"),
									children: [
										{
											cls: GROUP,
											bounds: "[48,693][672,1104]",
											id: pkg("description_layout"),
											children: [
												{
													cls: TEXT,
													bounds: "[48,693][672,764]",
													id: pkg("description_title"),
													text: "Passwords are saved to Google Password Manager",
												},
												{
													cls: TEXT,
													bounds: "[100,796][467,834]",
													id: pkg("description1"),
													text: "Keep track of your passwords",
												},
											],
										},
										{
											cls: GROUP,
											bounds: "[48,1104][672,1188]",
											id: pkg("username_layout"),
											children: [
												{ cls: TEXT, bounds: "[48,1104][157,1137]", id: pkg("username_text_view"), text: "Username" },
												{ cls: TEXT, bounds: "[48,1145][326,1188]", id: pkg("text1"), text: "test@example.com" },
											],
										},
										{
											cls: GROUP,
											bounds: "[48,1188][672,1308]",
											id: pkg("password_layout"),
											children: [
												{ cls: TEXT, bounds: "[48,1224][154,1257]", id: pkg("password_text_view"), text: "Password" },
												{ cls: TEXT, bounds: "[48,1265][147,1308]", id: pkg("text2"), text: "•••••••••" },
											],
										},
									],
								},
							],
						},
					],
				},
				{
					cls: GROUP,
					bounds: "[48,1372][672,1468]",
					children: [
						{ cls: BUTTON, bounds: "[48,1384][256,1456]", id: pkg("autofill_save_no"), text: "Never", clickable: true },
						{
							cls: BUTTON,
							bounds: "[464,1387][672,1459]",
							id: pkg("autofill_save_yes"),
							text: "Continue",
							clickable: true,
						},
					],
				},
			],
		},
	],
};

export const AUTOFILL_SAVE_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${render(
	{ cls: "android.widget.FrameLayout", bounds: "[0,0][720,1600]", children: [tree] },
	0
)}</hierarchy>`;
