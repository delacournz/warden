import type { Server } from "bun";
import type { InspectorTarget } from "./inspector";

type SocketData = { connection: FakeConnection | undefined };

/**
 * In-process fake Metro for tests: `/status`, `/json/list`, `POST /reload` over HTTP and a scripted CDP
 * JSON-RPC server on `/inspector/debug`, all on one `Bun.serve` port. Use the real `fetch` / `WebSocket`.
 */

export type FakeCdpRequest = { id: number; method: string; params: Record<string, unknown> };

/** `silent` = never answer (to provoke timeouts). */
export type FakeReply = { result: unknown } | { error: { message: string } } | "silent";

export type FakeConnection = {
	readonly id: number;
	emit: (method: string, params?: unknown) => void;
	close: () => void;
};

export type FakeMetroOptions = {
	/** Script a reply; return `undefined` to fall through to the default (`{}`, binding probe answers `function`). */
	respond?: (request: FakeCdpRequest, connection: FakeConnection) => FakeReply | undefined;
	targets?: InspectorTarget[];
	/** make `/status` answer something that is not Metro */
	notMetro?: boolean;
};

export type FakeMetro = {
	url: string;
	port: number;
	wsUrl: (device?: string, page?: number) => string;
	/** every CDP request, in arrival order, across connections */
	requests: FakeCdpRequest[];
	connections: FakeConnection[];
	/** path + query of every inspector socket upgrade, in order */
	upgrades: string[];
	reloadPosts: number;
	setTargets: (targets: InspectorTarget[]) => void;
	/** broadcast a CDP event to every open connection */
	emit: (method: string, params?: unknown) => void;
	/** close every open connection (the app went away) */
	dropAll: () => void;
	stop: () => Promise<void>;
};

export function fakeTarget(port: number, page: number, overrides: Partial<InspectorTarget> = {}): InspectorTarget {
	return {
		id: `dev1-${page}`,
		title: "Hermes React Native",
		description: "com.example.app",
		vm: "Hermes",
		deviceName: "iPhone A",
		appId: "com.example.app",
		webSocketDebuggerUrl: `ws://localhost:${port + 1}/inspector/debug?device=dev1&page=${page}`,
		reactNative: { logicalDeviceId: "dev1", capabilities: { prefersFuseboxFrontend: true } },
		...overrides,
	};
}

function defaultReply(request: FakeCdpRequest): FakeReply {
	if (request.method === "Runtime.evaluate" && request.params.expression === "typeof __warden_cb") {
		return { result: { result: { type: "string", value: "function" } } };
	}
	return { result: {} };
}

export function startFakeMetro(options: FakeMetroOptions = {}): FakeMetro {
	const requests: FakeCdpRequest[] = [];
	const connections: FakeConnection[] = [];
	const upgrades: string[] = [];
	const sockets = new Map<number, { send: (data: string) => void; close: () => void }>();
	let nextConnection = 1;
	let targets = options.targets;
	let reloadPosts = 0;

	const server: Server<SocketData> = Bun.serve<SocketData>({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/inspector/debug") {
				upgrades.push(`${url.pathname}${url.search}`);
				return srv.upgrade(req, { data: { connection: undefined } })
					? undefined
					: new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/status")
				return new Response(options.notMetro ? "<html></html>" : "packager-status:running");
			if (url.pathname === "/json/list" || url.pathname === "/json") {
				return Response.json(targets ?? [fakeTarget(server.port ?? 0, 1)]);
			}
			if (url.pathname === "/reload" && req.method === "POST") {
				reloadPosts++;
				return new Response("OK");
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				const id = nextConnection++;
				const connection: FakeConnection = {
					id,
					emit: (method, params) => ws.send(JSON.stringify({ method, params: params ?? {} })),
					close: () => ws.close(),
				};
				ws.data.connection = connection;
				sockets.set(id, ws);
				connections.push(connection);
			},
			message(ws, raw) {
				const connection = ws.data.connection;
				if (!connection) return;
				const parsed: { id: number; method: string; params?: Record<string, unknown> } = JSON.parse(String(raw));
				const request: FakeCdpRequest = { id: parsed.id, method: parsed.method, params: parsed.params ?? {} };
				requests.push(request);
				const reply = options.respond?.(request, connection) ?? defaultReply(request);
				if (reply === "silent") return;
				ws.send(JSON.stringify({ id: request.id, ...reply }));
			},
			close(ws) {
				const connection = ws.data.connection;
				if (!connection) return;
				sockets.delete(connection.id);
				const at = connections.indexOf(connection);
				if (at >= 0) connections.splice(at, 1);
			},
		},
	});
	const port = server.port ?? 0;
	// The listed ws urls point one port above on purpose: the inspector must rewrite them to the Metro URL.
	if (!targets) targets = [fakeTarget(port - 1, 1)];

	return {
		url: `http://127.0.0.1:${port}`,
		port,
		wsUrl: (device = "dev1", page = 1) => `ws://127.0.0.1:${port}/inspector/debug?device=${device}&page=${page}`,
		requests,
		connections,
		upgrades,
		get reloadPosts() {
			return reloadPosts;
		},
		setTargets(next) {
			targets = next;
		},
		emit(method, params) {
			for (const c of [...connections]) c.emit(method, params);
		},
		dropAll() {
			for (const c of [...connections]) c.close();
		},
		// Not awaited: `stop(true)` can stay pending on a socket the server closed itself.
		stop: async () => {
			void server.stop(true);
		},
	};
}
