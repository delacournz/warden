import type { KeyName, Point } from "@delacour/warden-e2e/driver/driver.types";

/**
 * `warden view <host lease>`'s browser page: a loopback server whose every path starts with a random token, frames
 * pulled from the host's driver (`screenshot`) one at a time, and pointer input sent back as taps and swipes.
 */

export type Size = { width: number; height: number };

export type ViewRoute = "page" | "frame" | "input";

/** Width and height from a PNG's IHDR; `undefined` when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): Size | undefined {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** A 0..1 point on the frame → the device's own coordinates (iOS points, Android pixels), rounded and clamped. */
export function toDevicePoint(p: Point, screen: Size): Point {
	return { x: Math.round(clamp(p.x) * screen.width), y: Math.round(clamp(p.y) * screen.height) };
}

/**
 * Which route a request is, or `undefined` to refuse it: the token must lead the path, `Host` must be this loopback
 * address (a rebinding hostname is refused), and a POST must come from this page's own origin.
 */
export function allowedRequest(req: Request, o: { token: string; port: number }): ViewRoute | undefined {
	const self = `127.0.0.1:${o.port}`;
	if (req.headers.get("host") !== self) return undefined;
	const path = new URL(req.url).pathname;
	const prefix = `/${o.token}/`;
	if (!path.startsWith(prefix)) return undefined;
	const rest = path.slice(prefix.length);
	if (req.method === "GET" && rest === "") return "page";
	if (req.method === "GET" && rest === "frame") return "frame";
	if (req.method === "POST" && rest === "input" && req.headers.get("origin") === `http://${self}`) return "input";
	return undefined;
}

export type ViewInput =
	| { kind: "tap"; x: number; y: number }
	| { kind: "swipe"; from: Point; to: Point; durationMs: number }
	| { kind: "type"; text: string }
	| { kind: "key"; key: ViewKey }
	| { kind: "home" };

/** the keys the page forwards as keys (everything else printable is typed) */
export const VIEW_KEYS = [
	"Enter",
	"Backspace",
	"Tab",
	"Up",
	"Down",
	"Left",
	"Right",
] as const satisfies readonly KeyName[];
export type ViewKey = (typeof VIEW_KEYS)[number];
const isViewKey = (v: unknown): v is ViewKey => VIEW_KEYS.some((k) => k === v);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): v is Point =>
	typeof v === "object" && v !== null && isNum(Reflect.get(v, "x")) && isNum(Reflect.get(v, "y"));

/** The page's input body, checked. */
export function parseViewInput(body: unknown): ViewInput | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const kind: unknown = Reflect.get(body, "kind");
	if (kind === "tap" && isPoint(body)) return { kind, x: body.x, y: body.y };
	if (kind === "home") return { kind };
	const text: unknown = Reflect.get(body, "text");
	if (kind === "type" && typeof text === "string" && text.length <= 1_000) return { kind, text };
	const key: unknown = Reflect.get(body, "key");
	if (kind === "key" && isViewKey(key)) return { kind, key };
	const from: unknown = Reflect.get(body, "from");
	const to: unknown = Reflect.get(body, "to");
	const durationMs: unknown = Reflect.get(body, "durationMs");
	if (kind === "swipe" && isPoint(from) && isPoint(to) && isNum(durationMs)) {
		return { kind, from, to, durationMs: Math.min(2_000, Math.max(50, durationMs)) };
	}
	return undefined;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page: one image, refetched as soon as the last frame landed; pointer down→up is a tap or a swipe. */
export function viewPageHtml(o: { title: string; watch: boolean }): string {
	const title = escapeHtml(o.title);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--fg:#18181b;--dim:#71717a}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--dim:#a1a1aa}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px ui-sans-serif,system-ui,sans-serif}
main{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:12px;box-sizing:border-box}
img{max-height:calc(100% - 40px);max-width:100%;border-radius:18px;touch-action:none;user-select:none;-webkit-user-drag:none;cursor:${o.watch ? "default" : "pointer"}}
p{margin:0;color:var(--dim)}
</style></head>
<body><main><img id="screen" alt="${title}"><p id="status">connecting…</p></main>
<script>
const watch=${o.watch ? "true" : "false"};
const img=document.getElementById("screen"),status=document.getElementById("status");
let frames=0,last=performance.now(),url;
async function next(){
  try{
    const r=await fetch("frame",{cache:"no-store"});
    if(!r.ok){status.textContent=(await r.text())||("frame failed: "+r.status);setTimeout(next,1000);return;}
    const blob=await r.blob(),old=url;url=URL.createObjectURL(blob);img.src=url;if(old)URL.revokeObjectURL(old);
    frames++;const now=performance.now();
    if(now-last>1000){status.textContent=(watch?"watching · ":"")+Math.round(frames*1000/(now-last))+" fps";frames=0;last=now;}
    next();
  }catch(e){status.textContent="disconnected: the warden view command ended";}
}
function rel(e){const b=img.getBoundingClientRect();return{x:(e.clientX-b.left)/b.width,y:(e.clientY-b.top)/b.height};}
function send(body){return fetch("input",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});}
if(!watch){
  let down;
  img.addEventListener("pointerdown",e=>{down={p:rel(e),t:performance.now()};img.setPointerCapture(e.pointerId);});
  img.addEventListener("pointerup",e=>{if(!down)return;const p=rel(e),dt=performance.now()-down.t;
    const moved=Math.hypot(p.x-down.p.x,p.y-down.p.y)>0.02;
    send(moved?{kind:"swipe",from:down.p,to:p,durationMs:dt}:{kind:"tap",x:p.x,y:p.y});down=undefined;});
  addEventListener("keydown",e=>{if(e.metaKey||e.ctrlKey)return;
    if(e.key==="Escape"){send({kind:"home"});return;}
    const k={Enter:"Enter",Backspace:"Backspace",Tab:"Tab",ArrowUp:"Up",ArrowDown:"Down",ArrowLeft:"Left",ArrowRight:"Right"}[e.key];
    if(k){e.preventDefault();send({kind:"key",key:k});return;}
    if(e.key.length===1){e.preventDefault();send({kind:"type",text:e.key});}});
}
next();
</script></body></html>`;
}
