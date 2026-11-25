import type { Server, ServerWebSocket } from "bun";
import { decodeControl, decodeData, encodeData } from "./relay-protocol";

/**
 * A stand-in for warden-api's relay (RMT-14 builds the real one): `GET /v1/hosts` for the user token, the host's
 * uplink at `/v1/hosts/uplink`, laptop dials at `/v1/hosts/<id>/dial`. Routes channels exactly as the protocol in
 * `relay-protocol.ts` says, and stamps the owner from the dial's `X-Warden-Machine` and the user.
 */

type DialRole = { role: "dial"; machine: string; ch?: number };
type Role = { role: "host" } | DialRole;

export type FakeRelay = {
	url: string;
	hostId: string;
	/** dials seen: the command lines asked for */
	dials: string[][];
	stop: () => void;
};

export function startFakeRelay(o: {
	hostToken: string;
	userToken: string;
	hostId?: string;
	name?: string;
	expiresAt?: number;
	user?: string;
}): FakeRelay {
	const hostId = o.hostId ?? "h1";
	const user = o.user ?? "me@example.com";
	let host: ServerWebSocket<Role> | undefined;
	const dialsByCh = new Map<number, ServerWebSocket<Role>>();
	const dials: string[][] = [];
	let nextCh = 1;
	const onHost = (message: string | Buffer) => {
		if (typeof message !== "string") {
			const d = decodeData(new Uint8Array(message));
			if (d) dialsByCh.get(d.ch)?.send(encodeData(d.stream, 0, d.payload));
			return;
		}
		const c = decodeControl(message);
		if (c?.t === "exit" && c.ch !== undefined) {
			dialsByCh.get(c.ch)?.send(JSON.stringify({ t: "exit", code: c.code }));
			dialsByCh.delete(c.ch);
		}
	};
	const openDial = (ws: ServerWebSocket<Role>, dial: DialRole, cmd: string[]) => {
		dials.push(cmd);
		if (host === undefined) {
			ws.send(JSON.stringify({ t: "error", code: "HOST_OFFLINE", message: `${hostId} is not connected` }));
			return;
		}
		const ch = nextCh++;
		dial.ch = ch;
		dialsByCh.set(ch, ws);
		host.send(JSON.stringify({ t: "open", ch, cmd, owner: { machineId: dial.machine, user } }));
	};
	const onDial = (ws: ServerWebSocket<Role>, dial: DialRole, message: string | Buffer) => {
		if (typeof message !== "string") {
			const d = decodeData(new Uint8Array(message));
			if (d && dial.ch !== undefined) host?.send(encodeData(d.stream, dial.ch, d.payload));
			return;
		}
		const c = decodeControl(message);
		if (c?.t === "open") openDial(ws, dial, c.cmd);
		else if (c?.t === "eof" && dial.ch !== undefined) host?.send(JSON.stringify({ t: "eof", ch: dial.ch }));
	};
	const listed = () => ({
		id: hostId,
		name: o.name ?? "mini",
		status: host !== undefined ? "online" : "offline",
		...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
	});
	const upgrade = (srv: Server<Role>, req: Request, data: Role) =>
		srv.upgrade(req, { data }) ? undefined : new Response("no", { status: 400 });
	type Route = { token: string; serve: (srv: Server<Role>, req: Request) => Response | undefined };
	const routes = new Map<string, Route>([
		["/v1/hosts", { token: o.userToken, serve: () => Response.json([listed()]) }],
		["/v1/hosts/uplink", { token: o.hostToken, serve: (srv, req) => upgrade(srv, req, { role: "host" }) }],
		[
			`/v1/hosts/${hostId}/dial`,
			{
				token: o.userToken,
				serve: (srv, req) => upgrade(srv, req, { role: "dial", machine: req.headers.get("x-warden-machine") ?? "" }),
			},
		],
	]);
	const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "");
	const server = Bun.serve<Role>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const path = new URL(req.url).pathname;
			const route = routes.get(path);
			if (route === undefined) return new Response("not found", { status: 404 });
			if (bearer(req) !== route.token) return new Response("unauthorized", { status: 401 });
			return route.serve(srv, req);
		},
		websocket: {
			open(ws) {
				if (ws.data.role === "host") host = ws;
			},
			message(ws, message) {
				if (ws.data.role === "host") onHost(message);
				else onDial(ws, ws.data, message);
			},
			close(ws) {
				if (ws.data.role === "host") host = undefined;
			},
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, hostId, dials, stop: () => server.stop(true) };
}
