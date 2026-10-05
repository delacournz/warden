import { ScreenChatList } from "./screen-chat-list";
import { ScreenContent } from "./screen-content";
import { ScreenError } from "./screen-error";
import { ScreenFlatList } from "./screen-flat-list";
import { ScreenFooter } from "./screen-footer";
import { ScreenHeader } from "./screen-header";
import { ScreenLegendList } from "./screen-legend-list";
import { ScreenLoading } from "./screen-loading";
import { ScreenNavbar } from "./screen-navbar";
import { ScreenRoot } from "./screen-root";
import { ScreenScrollArea } from "./screen-scroll-area";
import { ScreenScrollShadow } from "./screen-scroll-shadow";
import { ScreenSectionList } from "./screen-section-list";
import { ScreenView } from "./screen-view";

/**
 * A screen's frame: pinned chrome, a content region, and whatever scrolls
 * between them.
 *
 * The problem it solves is that a navbar and a footer only know their own
 * heights once they have laid out, and everything else on the screen has to
 * clear them. Each publishes its measured height into a Reanimated context, and
 * every scrollable reserves exactly that — so no screen carries a hand-tuned
 * padding number that is right on one device and wrong on the next.
 *
 * Compose the parts in visual order. The navbar and footer default to
 * `placement="overlay"`, floating above the content with the content insetting
 * itself to match; `placement="static"` puts either in the flow instead.
 *
 * Requires `DelacourProvider` at the app's root — it mounts the safe-area
 * provider, the keyboard provider and the `<KeyboardStateSync />` a screen
 * depends on. Compose those by hand only in an app that already has a root
 * stack of its own, and keep the state sync: without it a keyboard that
 * vanishes without notice leaves every screen in the app believing it is still
 * open.
 *
 * @example
 * // Navbar, scrolling body and a footer action.
 * <Screen>
 *   <Screen.Navbar>
 *     <Screen.Navbar.BackButton onPress={() => router.back()}>
 *       <Screen.Navbar.Title>Settings</Screen.Navbar.Title>
 *     </Screen.Navbar.BackButton>
 *   </Screen.Navbar>
 *   <Screen.ScrollArea contentContainerClassName="gap-4 px-5">
 *     <Screen.Header>
 *       <Text.Header>Notifications</Text.Header>
 *     </Screen.Header>
 *     {rows}
 *   </Screen.ScrollArea>
 *   <Screen.Footer>
 *     <Button onPress={save}>Save</Button>
 *   </Screen.Footer>
 * </Screen>
 *
 * @example
 * // A form: the focused field stays clear of the keyboard and the footer.
 * <Screen>
 *   <Screen.Navbar placement="static" center={<Screen.Navbar.Title>New customer</Screen.Navbar.Title>} />
 *   <Screen.ScrollArea keyboardAware contentContainerClassName="gap-4 px-5">
 *     <CustomerForm />
 *   </Screen.ScrollArea>
 * </Screen>
 *
 * @example
 * // Static content, no scrolling — padded for whatever chrome is mounted.
 * <Screen>
 *   <Screen.Navbar />
 *   <Screen.View className="items-center justify-center">
 *     <Text>Nothing here yet</Text>
 *   </Screen.View>
 * </Screen>
 *
 * @example
 * // A conversation: composer rides the keyboard, newest message stays clear of it.
 * <Screen>
 *   <Screen.Navbar placement="static" />
 *   <Screen.Content textInputNativeID={SCREEN_CHAT_INPUT_NATIVE_ID}>
 *     <Screen.ChatList composerBaseHeight={56} data={messages} renderItem={renderMessage} />
 *   </Screen.Content>
 *   <Screen.Footer sticky>
 *     <MessageComposer textInputNativeID={SCREEN_CHAT_INPUT_NATIVE_ID} />
 *   </Screen.Footer>
 * </Screen>
 */
export const Screen = Object.assign(ScreenRoot, {
	/** The bar pinned to the top, with its `Title`, `Subtitle` and `BackButton` slots. */
	Navbar: ScreenNavbar,
	/** The content region: keyboard gesture area, surface, and optional safe-area edges. */
	Content: ScreenContent,
	/** A non-scrolling body, padded for whatever chrome is mounted. */
	View: ScreenView,
	/** A titled block on the screen's own gutter, scrolling with the content. */
	Header: ScreenHeader,
	/** A pinned region at the bottom, optionally riding the keyboard. */
	Footer: ScreenFooter,
	/** A scrolling body that clears the chrome at both ends. */
	ScrollArea: ScreenScrollArea,
	/** A fade at each end of whichever body is mounted, for content that runs past it. */
	ScrollShadow: ScreenScrollShadow,
	/** A virtualised list that clears the chrome at both ends. */
	FlatList: ScreenFlatList,
	/** A sectioned virtualised list, with sticky section headers. */
	SectionList: ScreenSectionList,
	/** A recycling list, for a long or heterogeneous body. */
	LegendList: ScreenLegendList,
	/** A conversation list: composer clearance, keyboard lift and end anchoring. */
	ChatList: ScreenChatList,
	/** A whole screen showing a spinner, for a route whose data is in flight. */
	Loading: ScreenLoading,
	/** A whole screen explaining that something failed. */
	Error: ScreenError,
	displayName: "DelacourUI.Screen",
});
