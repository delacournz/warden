import { err, ok, type Result } from "@delacour/warden-types/result";

/**
 * What `warden sim slim` may switch off inside an iOS simulator: 15 categories of `launchd_sim`
 * jobs, each a coherent feature area (widgets, Siri, iCloud…) so a suite can keep one with
 * `slim: { except: ["store"] }`. Labels the e2e stack depends on live in `slim.ts` `NEVER_DISABLE`
 * and are left out here; labels that break boot are in `FORBIDDEN_LABELS` and never touched.
 */

/** A label a category must leave enabled because something common breaks without it. */
export type AlwaysEnabled = { label: string; reason: string };

export type SlimCategory = {
	id: string;
	name: string;
	labels: readonly string[];
	alwaysEnabled?: readonly AlwaysEnabled[];
};

const apple = (...ids: string[]): readonly string[] => ids.map((id) => `com.apple.${id}`);

export const SLIM_CATEGORIES: readonly SlimCategory[] = [
	{
		id: "widgets",
		name: "Widgets, posters and live activities",
		labels: apple("PosterBoard", "chronod", "liveactivitiesd", "navd"),
	},
	{
		id: "siri",
		name: "Siri, speech and Apple Intelligence",
		labels: apple(
			"assistant_cdmd",
			"assistant_service",
			"siriactionsd",
			"siriinferenced",
			"siriknowledged",
			"sirittsd",
			"siri.context.service",
			"siri.acousticsignature",
			"voiced",
			"voicebankingd",
			"speechmodeltrainingd",
			"intelligenceplatformd",
			"intelligencecontextd",
			"intelligenceflowd",
			"intelligencetasksd",
			"generativeexperiencesd",
			"knowledgeconstructiond",
			"naturallanguaged",
			"textunderstandingd",
			"modelcatalogd",
			"modelmanagerd",
			"mlhostd",
			"mlruntimed",
			"suggestd",
			"parsecd",
			"parsec-fbf",
			"proactiveeventtrackerd"
		),
		alwaysEnabled: [{ label: "com.apple.assistantd", reason: "hosts dictation; the keyboard loops without it" }],
	},
	{
		id: "search",
		name: "Spotlight search",
		labels: apple("searchtoold", "spotlightknowledged", "spotlightknowledged.updater", "corespotlightservice"),
	},
	{
		id: "icloud",
		name: "iCloud, accounts and sync",
		labels: apple(
			"appleaccountd",
			"appleaccounttransparencyd",
			"appleidsetupd",
			"akd",
			"amsaccountsd",
			"amsengagementd",
			"amsondevicestoraged",
			"cloudd",
			"cloudphotod",
			"ckdiscretionaryd",
			"cloudsettingssyncagent",
			"bird",
			"syncdefaultsd",
			"cdpd",
			"sosd",
			"SecureBackupDaemon",
			"TrustedPeersHelper",
			"protectedcloudstorage.protectedcloudkeysyncing",
			"icloudmailagent",
			"icloudsubscriptionoptimizerd",
			"communicationtrustd"
		),
	},
	{
		id: "store",
		name: "App Store, push and media services",
		labels: apple(
			"appstored",
			"appstorecomponentsd",
			"apsd",
			"itunescloudd",
			"itunesstored",
			"storekitd",
			"amsaccountsd",
			"amsengagementd",
			"amsondevicestoraged",
			"passd",
			"financed",
			"videosubscriptionsd",
			"assetsubscriptiond",
			"musicd"
		),
	},
	{
		id: "pim",
		name: "Mail, calendar, reminders and contacts",
		labels: apple(
			"email.maild",
			"exchangesyncd",
			"dataaccess.dataaccessd",
			"calaccessd",
			"remindd",
			"contactsd",
			"contacts.postersyncd",
			"peopled"
		),
	},
	{
		id: "web",
		name: "Safari sync, web push and universal links",
		labels: apple(
			"SafariBookmarksSyncAgent",
			"Safari.History",
			"Safari.passwordbreachd",
			"Safari.SafeBrowsing.Service",
			"safarifetcherd",
			"WebBookmarks.webbookmarksd",
			"webkit.adattributiond",
			"webkit.webpushd",
			"webprivacyd",
			"swcd"
		),
	},
	{
		id: "family",
		name: "Family sharing and Screen Time",
		labels: apple(
			"familycircled",
			"FamilyControlsAgent",
			"familynotification",
			"askpermissiond",
			"asktod",
			"ScreenTimeAgent",
			"ScreenTimeSettingsAgent",
			"UsageTrackingAgent"
		),
	},
	{
		id: "health",
		name: "Health, fitness and Home",
		labels: apple(
			"healthd",
			"healthappd",
			"healthcontentd",
			"healtheventsd",
			"healthrecordsd",
			"finhealthd",
			"homed",
			"homeeventsd",
			"fitcore",
			"fitcore.session",
			"fitnesscoachingd",
			"fitnessintelligenced",
			"activityawardsd",
			"activitysharingd"
		),
	},
	{
		id: "photos",
		name: "Photos and media analysis",
		labels: apple(
			"photoanalysisd",
			"photosface",
			"mediaanalysisd",
			"mediaanalysisd.service",
			"mediastream.mstreamd",
			"medialibraryd",
			"assetsd",
			"assetsd.nebulad"
		),
	},
	{
		id: "apps",
		name: "News, Weather, Maps, Tips and games",
		labels: apple(
			"newsd",
			"weatherd",
			"Maps.mapssyncd",
			"Maps.mapspushd",
			"Maps.geocorrectiond",
			"maps.destinationd",
			"MapKit.SnapshotService",
			"jetpackassetd",
			"tipsd",
			"gamesaved",
			"GameController.gamecontrollerd"
		),
		alwaysEnabled: [{ label: "com.apple.gamed", reason: "XCUITest launch waits ~10 s on GameKit without it" }],
	},
	{
		id: "messaging",
		name: "iMessage, FaceTime and telephony",
		labels: apple(
			"identityservicesd",
			"ids_simd",
			"imautomatichistorydeletionagent",
			"imcore.imtransferagent",
			"imdpersistence.IMDPersistenceAgent",
			"facetimemessagestored",
			"telephonyutilities.callservicesd"
		),
	},
	{
		id: "connectivity",
		name: "Nearby devices, CarPlay and sharing",
		labels: apple(
			"rapportd",
			"companiond",
			"carkitd",
			"wcd",
			"tvremoted",
			"avatarsd",
			"stickersd",
			"sociallayerd",
			"announced",
			"navd",
			"findmy.findmylocated"
		),
		alwaysEnabled: [{ label: "com.apple.sharingd", reason: "system share sheets" }],
	},
	{
		id: "telemetry",
		name: "Analytics, ads and diagnostics",
		labels: apple(
			"ap.adprivacyd",
			"ap.promotedcontentd",
			"diagnosticextensionsd",
			"feedbackd",
			"rtcreportingd",
			"securityuploadd",
			"geoanalyticsd",
			"triald",
			"followupd",
			"purplebuddy.budd",
			"devicecheckd"
		),
	},
	{
		id: "other",
		name: "Wallet, identity and miscellaneous",
		labels: apple(
			"financed",
			"passd",
			"merchantd",
			"coreidvd",
			"businessservicesd",
			"deviceaccessd",
			"replicatord",
			"linkd",
			"ind",
			"storagedatad",
			"StatusKitAgent",
			"countryd",
			"managedconfiguration.passcodenagd"
		),
	},
];

/** Jobs whose absence breaks boot or the home screen (observed): never disabled, whatever a profile says. */
export const FORBIDDEN_LABELS: readonly string[] = [
	"com.apple.nanoregistryd",
	"com.apple.nanoregistrylaunchd",
	"com.apple.nanoprefsyncd.2",
	"com.apple.nanotimekitcompaniond",
	"com.apple.nanobackupd",
	"com.apple.sleepd",
	"com.apple.appprotectiond",
	"com.apple.ManagedSettingsAgent",
	"com.apple.managedconfiguration.profiled",
	"com.apple.mobiletimerd",
	"com.apple.routined",
	"com.apple.biomed",
	"com.apple.biomesyncd",
	"com.apple.dmd",
	"com.apple.donotdisturbd",
];

/**
 * Which categories stay on (`except`, by id) and which single labels stay on (`keep`, full launchd
 * labels). A label listed by any excepted category stays on even when another category lists it too.
 */
export type SlimProfile = { except: readonly string[]; keep: readonly string[] };

export const DEFAULT_SLIM_PROFILE: SlimProfile = { except: [], keep: [] };

/** Every label some category may switch off. */
export function slimmableSet(): Set<string> {
	return new Set(SLIM_CATEGORIES.flatMap((category) => category.labels));
}

/** Slimmable labels plus the `alwaysEnabled` ones: the labels warden is allowed to write an override for. */
export function managedSet(): Set<string> {
	const managed = slimmableSet();
	for (const category of SLIM_CATEGORIES) {
		for (const entry of category.alwaysEnabled ?? []) managed.add(entry.label);
	}
	return managed;
}

/** The labels to have disabled under `profile`, in category order. */
export function desiredLabels(profile: SlimProfile): Set<string> {
	const kept = new Set<string>(profile.keep);
	for (const category of SLIM_CATEGORIES) {
		if (profile.except.includes(category.id)) for (const label of category.labels) kept.add(label);
	}
	const desired = new Set<string>();
	for (const category of SLIM_CATEGORIES) {
		for (const label of category.labels) if (!kept.has(label)) desired.add(label);
	}
	return desired;
}

/**
 * What to change to reach `desired`: disable the wanted labels not yet disabled, enable the managed
 * labels that are disabled but not wanted. A disabled label outside `managed` is not ours, so it is
 * never re-enabled. `current` is `print-disabled` (label → disabled) or just the disabled labels.
 */
export function delta(
	current: ReadonlyMap<string, boolean> | ReadonlySet<string>,
	desired: ReadonlySet<string>,
	managed: ReadonlySet<string>
): { toDisable: string[]; toEnable: string[] } {
	const isDisabled = (label: string): boolean =>
		current instanceof Map ? current.get(label) === true : (current as ReadonlySet<string>).has(label);
	const toDisable = [...desired].filter((label) => !isDisabled(label));
	const toEnable = [...managed].filter((label) => !desired.has(label) && isDisabled(label));
	return { toDisable: toDisable.sort(), toEnable: toEnable.sort() };
}

/** Reject category ids that do not exist and `keep` labels warden does not manage; messages name the culprit. */
export function validateProfile(profile: SlimProfile): Result<SlimProfile> {
	const ids = new Set(SLIM_CATEGORIES.map((category) => category.id));
	const badIds = profile.except.filter((id) => !ids.has(id));
	if (badIds.length > 0)
		return err(
			`unknown slim categor${badIds.length === 1 ? "y" : "ies"}: ${badIds.join(", ")} (known: ${[...ids].join(", ")})`
		);
	const managed = managedSet();
	const badLabels = profile.keep.filter((label) => !managed.has(label));
	if (badLabels.length > 0)
		return err(`not a slimmable label: ${badLabels.join(", ")} (see \`warden sim profiles --json\`)`);
	return ok({ except: [...profile.except], keep: [...profile.keep] });
}

/** The categories for `warden sim profiles`. */
export function describeCategories(): { id: string; name: string; labelCount: number; labels: readonly string[] }[] {
	return SLIM_CATEGORIES.map((category) => ({
		id: category.id,
		name: category.name,
		labelCount: category.labels.length,
		labels: category.labels,
	}));
}
